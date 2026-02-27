/**
 * Anthropic (Claude) Personalization Module
 *
 * Generates WhatsApp-safe personalized snippets for leads using the
 * "Sofia" persona. Handles two tracks:
 *   Track A — High Signal (has crmf + jobtitle + company)
 *   Track B — Low Signal (partial/missing data)
 *
 * Supports multi-language output: Portuguese, Spanish, English
 */
const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');
const { logger, withRetry } = require('./utils');

let client = null;

function getClient() {
    if (!client) {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set in .env');
        client = new Anthropic({ apiKey });
    }
    return client;
}

/**
 * Determine signal track based on available data
 *
 * Track A (High Signal): has crmf + jobtitle + company
 * Track B (Low Signal): missing one or more key fields
 *
 * @param {object} props - Contact properties (merged: original + enriched)
 * @returns {'A'|'B'}
 */
function determineTrack(props) {
    const hasCrmf = !!(props.crmf || props.ds_lidegree);
    const hasTitle = !!props.jobtitle;
    const hasCompany = !!props.company;

    if (hasCrmf && hasTitle && hasCompany) return 'A';
    return 'B';
}

/**
 * Build a human-readable lead data summary for the prompt
 *
 * @param {object} props - Contact properties
 * @returns {string}
 */
function buildLeadDataSummary(props) {
    const lines = [];
    if (props.firstname || props.lastname) {
        lines.push(`Name: ${(props.firstname || '')} ${(props.lastname || '')}`.trim());
    }
    if (props.jobtitle) lines.push(`Job Title: ${props.jobtitle}`);
    if (props.company) lines.push(`Company: ${props.company}`);
    if (props.industry) lines.push(`Industry: ${props.industry}`);
    if (props.numemployees) lines.push(`Company Size: ~${props.numemployees} employees`);
    if (props.country) lines.push(`Country: ${props.country}`);
    if (props.language) lines.push(`Language: ${props.language}`);
    if (props.crmf) lines.push(`CRM Used: ${props.crmf}`);
    if (props.ds_lidegree) lines.push(`CRM Technology: ${props.ds_lidegree}`);
    if (props.photo_url) lines.push(`Integration Status: ${props.photo_url}`);
    if (props.final_linkedin_link) lines.push(`Has LinkedIn: Yes`);

    // Add create date as relative time for context
    if (props.createdate) {
        const created = new Date(props.createdate);
        const daysAgo = Math.floor((Date.now() - created.getTime()) / (1000 * 60 * 60 * 24));
        if (daysAgo === 0) lines.push('Lead Created: Today');
        else if (daysAgo === 1) lines.push('Lead Created: Yesterday');
        else lines.push(`Lead Created: ${daysAgo} days ago`);
    }

    if (lines.length === 0) {
        lines.push('Very limited data available — use general WhatsApp + CRM context.');
    }

    return lines.join('\n');
}

/**
 * Validate a generated snippet against Meta/WhatsApp safety rules
 *
 * @param {string} text - The generated snippet
 * @returns {{ valid: boolean, violations: string[] }}
 */
function validateSnippet(text) {
    const violations = [];

    if (!text || text.trim() === '') {
        violations.push('Empty snippet');
        return { valid: false, violations };
    }

    // Length check
    if (text.length > config.MAX_SNIPPET_LENGTH) {
        violations.push(`Too long: ${text.length}/${config.MAX_SNIPPET_LENGTH} chars`);
    }

    // Line breaks check (should be single paragraph)
    if (text.includes('\n')) {
        violations.push('Contains line breaks');
    }

    // Forbidden words (check in all languages)
    const lower = text.toLowerCase();
    for (const word of config.FORBIDDEN_WORDS) {
        const regex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (regex.test(lower)) {
            violations.push(`Forbidden word: "${word}"`);
        }
    }

    // URL check
    if (/https?:\/\/|www\./i.test(text)) {
        violations.push('Contains URL');
    }

    // Assumption phrases check
    const assumptionPhrases = ['i saw you', 'i noticed you visited', 'you signed up', 'you registered'];
    for (const phrase of assumptionPhrases) {
        if (lower.includes(phrase)) {
            violations.push(`Assumption phrase: "${phrase}"`);
        }
    }

    return { valid: violations.length === 0, violations };
}

/**
 * Generate a personalized WhatsApp snippet for a contact
 *
 * @param {object} props - Contact properties (merged: original + enriched)
 * @param {object} opts
 * @param {boolean} opts.isRetry - If true, use stricter prompt language
 * @param {string} opts.language - Target language: 'Portuguese', 'Spanish', or 'English'
 * @returns {Promise<{ snippet: string, track: string } | null>}
 */
async function generateSnippet(props, { isRetry = false, language = 'English' } = {}) {
    const anthropic = getClient();
    const track = determineTrack(props);
    const leadData = buildLeadDataSummary(props);

    // Select prompt template based on track
    const promptTemplate = track === 'A' ? config.TRACK_A_PROMPT : config.TRACK_B_PROMPT;
    let userPrompt = promptTemplate.replace('{{LEAD_DATA}}', leadData);

    // Hard anti-greeting instruction appended to EVERY prompt
    userPrompt += '\n\nCRITICAL: Do NOT start with any greeting (Hey/Hi/Hello) or the lead\'s name. Start directly with an observation or insight. If you start with a greeting or name, the message will be REJECTED.';

    // Add language instruction
    if (language !== 'English') {
        userPrompt += `\n\nIMPORTANT: Write the snippet in ${language}. The lead speaks ${language} — the entire message must be in ${language}. Do NOT mix languages. Keep *asterisk bolding* for CRM/product names.`;
    }

    // On retry, add stricter constraints
    if (isRetry) {
        userPrompt += `\n\nIMPORTANT: Your previous attempt was rejected. Be EXTRA careful: keep under ${config.MAX_SNIPPET_LENGTH - 30} characters, no forbidden words, no line breaks, no URLs, no assumptions. Single paragraph only.${language !== 'English' ? ` Write in ${language}.` : ''}`;
    }

    try {
        const response = await withRetry(
            async () => {
                const msg = await anthropic.messages.create({
                    model: config.ANTHROPIC_MODEL,
                    max_tokens: config.ANTHROPIC_MAX_TOKENS,
                    temperature: config.ANTHROPIC_TEMPERATURE,
                    system: config.SOFIA_SYSTEM_PROMPT,
                    messages: [{ role: 'user', content: userPrompt }],
                });

                // Extract text from response
                const text = msg.content
                    .filter((block) => block.type === 'text')
                    .map((block) => block.text)
                    .join('')
                    .trim();

                return text;
            },
            { label: `Anthropic snippet (Track ${track}, ${language})`, maxRetries: 2, baseDelay: 1000 }
        );

        // Clean up: remove surrounding quotes if Claude wraps them
        let snippet = response.replace(/^["']|["']$/g, '').trim();

        // Remove any line breaks (force single paragraph)
        snippet = snippet.replace(/\n/g, ' ').replace(/\s{2,}/g, ' ');

        // Aggressively strip greeting patterns in EN/ES/PT
        // Catches: "Hey Name,", "Hi Name!", "Hola Name,", "Olá Name,", "Name, ...", etc.
        const greetingWords = '(?:Hey|Hi|Hello|Dear|Hola|Olá|Oi|Bom dia|Buenos días|Buenas tardes)';
        const namePattern = '[A-ZÀ-Ú][a-zA-ZÀ-ú]+(?:\\s+[A-ZÀ-Ú][a-zA-ZÀ-ú]+)?';  // First name or First Last

        // Pass 1: "Greeting Name[punctuation]"
        snippet = snippet.replace(new RegExp(`^${greetingWords}\\s+${namePattern}[!,.:;\\s]*\\s*`, 'i'), '').trim();
        // Pass 2: "Greeting! " or "Greeting, " alone
        snippet = snippet.replace(new RegExp(`^${greetingWords}[!,.:;]+\\s*`, 'i'), '').trim();
        // Pass 3: "Name, ..." (name-first pattern with comma)
        snippet = snippet.replace(new RegExp(`^${namePattern},\\s+`, 'i'), '').trim();

        // Capitalize first letter after stripping
        if (snippet.length > 0) {
            snippet = snippet.charAt(0).toUpperCase() + snippet.slice(1);
        }

        return { snippet, track };
    } catch (err) {
        logger.error(`  ❌ Anthropic generation failed: ${err.message}`);
        return null;
    }
}

module.exports = { generateSnippet, validateSnippet, determineTrack, buildLeadDataSummary };
