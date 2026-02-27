/**
 * Central configuration for Eazybe Lead Enrichment & Personalization Agent
 * 
 * Adjust these values to control what gets enriched, personalized, and how.
 */

// ── Date helpers ──────────────────────────────────────────────
function getStartOfWeek() {
    const now = new Date();
    const day = now.getDay(); // 0 = Sun, 1 = Mon ...
    const diff = now.getDate() - day + (day === 0 ? -6 : 1); // Monday
    const monday = new Date(now.setDate(diff));
    monday.setHours(0, 0, 0, 0);
    return monday.toISOString();
}

// ── Field Mapping: Apollo → HubSpot ───────────────────────────
// Each entry: { apolloPath, hubspotProperty, transform? }
// apolloPath uses dot notation into the Apollo response
// transform is an optional function to format the value before writing

const FIELD_MAP = [
    {
        label: 'LinkedIn URL',
        apolloPath: 'person.linkedin_url',
        hubspotProperty: 'final_linkedin_link',
    },
    {
        label: 'Job Title',
        apolloPath: 'person.title',
        hubspotProperty: 'jobtitle',
    },
    {
        label: 'Company Name',
        apolloPath: 'person.organization.name',
        hubspotProperty: 'company',
    },
    {
        label: 'Industry',
        apolloPath: 'person.organization.industry',
        hubspotProperty: 'industry',
    },
    {
        label: 'Employee Count',
        apolloPath: 'person.organization.estimated_num_employees',
        hubspotProperty: 'numemployees',
        transform: (val) => {
            if (val == null) return null;
            // Apollo gives ranges like "11-50" sometimes, HubSpot expects a number string
            const num = typeof val === 'string' ? parseInt(val.replace(/[^0-9]/g, ''), 10) : val;
            return isNaN(num) ? null : String(num);
        },
    },
    // Language is NOT in FIELD_MAP — it's handled by phone code detection in enricher.js
    // Country is NOT in FIELD_MAP — it's handled by phone code detection in enricher.js
    // CRM Source (ds_lidegree) is NOT in FIELD_MAP — we never overwrite CRMF or CRM Source
];

// ── CRM Technologies to detect ────────────────────────────────
// When Apollo returns an org's tech stack, we check for these CRM names
const CRM_KEYWORDS = [
    'salesforce', 'hubspot', 'zoho', 'pipedrive', 'freshsales',
    'freshworks', 'dynamics 365', 'microsoft dynamics', 'sugar crm',
    'sugarcrm', 'insightly', 'keap', 'infusionsoft', 'close',
    'copper', 'nimble', 'monday sales', 'nutshell', 'capsule',
    'agile crm', 'bitrix24', 'vtiger', 'streak', 'zendesk sell',
    'apptivo', 'less annoying crm', 'highrise', 'odoo',
];

// ── Main config export ────────────────────────────────────────
module.exports = {
    // HubSpot filter: fetch contacts where CRMF is known (not empty)
    // Set to null to fetch ALL new leads regardless of CRMF
    HUBSPOT_CRMF_PROPERTY: null,  // was 'crmf' — now fetches all new leads

    // Default: contacts created since start of this week
    // Override via CLI: --since 2026-02-15
    DEFAULT_CREATED_AFTER: getStartOfWeek(),

    HUBSPOT_PROPERTIES_TO_FETCH: [
        'firstname', 'lastname', 'email', 'phone', 'mobilephone',
        'hs_linkedin_url',  // sometimes HubSpot has its own LinkedIn field
        ...FIELD_MAP.map((f) => f.hubspotProperty),
        'crmf',
        'personalized_text',  // personalization output field
        'photo_url',          // integration status (teams)
        'createdate',         // lead creation date for timing context
    ],

    // Field mapping
    FIELD_MAP,

    // CRM detection keywords
    CRM_KEYWORDS,

    // Rate limiting
    BATCH_SIZE: 10,            // contacts per batch
    BATCH_DELAY_MS: 1500,      // delay between batches (ms)
    APOLLO_RATE_DELAY_MS: 500, // delay between individual Apollo calls (ms)

    // Retry config
    MAX_RETRIES: 3,
    RETRY_BASE_DELAY_MS: 2000,

    // ── Personalization (Anthropic) ───────────────────────────
    PERSONALIZATION_FIELD: 'personalized_text',
    INTEGRATION_STATUS_FIELD: 'photo_url',

    // Set to true to overwrite existing personalized_text (useful when improving prompts)
    // Set to false for normal daily operation (only fill empty fields)
    OVERWRITE_PERSONALIZED_TEXT: false,

    // ── Phone Country Code → Language Mapping ────────────────
    // Brazil → Portuguese, LATAM countries → Spanish, everything else → English
    BRAZIL_PHONE_CODES: ['+55'],
    LATAM_PHONE_CODES: [
        '+52',  // Mexico
        '+54',  // Argentina
        '+56',  // Chile
        '+57',  // Colombia
        '+51',  // Peru
        '+58',  // Venezuela
        '+593', // Ecuador
        '+591', // Bolivia
        '+595', // Paraguay
        '+598', // Uruguay
        '+506', // Costa Rica
        '+507', // Panama
        '+502', // Guatemala
        '+503', // El Salvador
        '+504', // Honduras
        '+505', // Nicaragua
        '+53',  // Cuba
        '+1809', '+1829', '+1849', // Dominican Republic
        '+509', // Haiti
    ],

    // Phone code → Country name mapping (for country detection without Apollo)
    PHONE_TO_COUNTRY: {
        '+55': 'Brazil',
        '+52': 'Mexico', '+54': 'Argentina', '+56': 'Chile',
        '+57': 'Colombia', '+51': 'Peru', '+58': 'Venezuela',
        '+593': 'Ecuador', '+591': 'Bolivia', '+595': 'Paraguay',
        '+598': 'Uruguay', '+506': 'Costa Rica', '+507': 'Panama',
        '+502': 'Guatemala', '+503': 'El Salvador', '+504': 'Honduras',
        '+505': 'Nicaragua', '+53': 'Cuba',
        '+1809': 'Dominican Republic', '+1829': 'Dominican Republic', '+1849': 'Dominican Republic',
        '+509': 'Haiti',
        '+1': 'United States', '+44': 'United Kingdom', '+91': 'India',
        '+49': 'Germany', '+33': 'France', '+39': 'Italy',
        '+34': 'Spain', '+61': 'Australia', '+81': 'Japan',
        '+86': 'China', '+82': 'South Korea', '+7': 'Russia',
        '+971': 'UAE', '+966': 'Saudi Arabia', '+20': 'Egypt',
        '+27': 'South Africa', '+234': 'Nigeria', '+254': 'Kenya',
        '+62': 'Indonesia', '+60': 'Malaysia', '+65': 'Singapore',
        '+63': 'Philippines', '+66': 'Thailand', '+84': 'Vietnam',
        '+90': 'Turkey', '+48': 'Poland', '+31': 'Netherlands',
        '+46': 'Sweden', '+47': 'Norway', '+45': 'Denmark',
        '+41': 'Switzerland', '+43': 'Austria', '+32': 'Belgium',
        '+351': 'Portugal', '+353': 'Ireland', '+972': 'Israel',
    },

    // Anthropic model config
    ANTHROPIC_MODEL: 'claude-sonnet-4-20250514',
    ANTHROPIC_MAX_TOKENS: 300,
    ANTHROPIC_TEMPERATURE: 0.7,

    // Max snippet length (WhatsApp compliance)
    MAX_SNIPPET_LENGTH: 200,

    // Meta-safety forbidden words (case-insensitive match)
    FORBIDDEN_WORDS: [
        'buy', 'offer', 'discount', 'upgrade', 'purchase',
        'sale', 'promo', 'promotion', 'limited time', 'exclusive',
        'hurry', 'immediately', 'urgent',
        'act now', 'buy now', 'sign up now', 'don\'t miss', 'last chance',
        'special deal', 'best price', 'free trial',
    ],

    // Sofia persona system prompt
    SOFIA_SYSTEM_PROMPT: `You are Sofia, Founding Team at Eazybe. You write short, warm, human WhatsApp message snippets.

STRICT RULES:
- Generate ONLY the personalized snippet. No greetings (Hi/Hello/Hey), no sign-offs, no CTAs.
- NEVER start with the lead's name. NEVER write "Hey [Name]", "[Name], ..." or any name-first pattern.
- Max 200 characters. Exactly one paragraph. 1–2 sentences. No line breaks.
- Use *asterisks* for WhatsApp bolding on key product/CRM names (e.g., *HubSpot*, *Salesforce*).
- Sound genuinely curious and observational, like a peer noticing something — NOT salesy.

META / WHATSAPP SAFETY (HARD RULES):
- NO sales/pressure words: Buy, Offer, Discount, Deal, Upgrade, Purchase, Sale, Promo.
- NO urgency words: Now, Today, Fast, Hurry, Immediately, Urgent, Act Now.
- NO links or URLs of any kind.
- NO assumptions like "I saw you signed up" or "I noticed you visited" or "noticed you just joined."
- Use observation-based framing: "Noticed your team uses..." or "Teams in [industry] often..."
- Keep it conversational and observation-based.`,

    // Track A prompt (High Signal: has crmf + jobtitle + company)
    TRACK_A_PROMPT: `Generate a personalized WhatsApp snippet for this lead. You have strong context — use it to write something specific and observational.

Lead data:
{{LEAD_DATA}}

INSTRUCTIONS:
- Reference their role, company, or CRM naturally using observation-based framing.
- Frame around a pain point someone in their role would face: WhatsApp conversations not syncing to CRM, lost customer context, manual data entry, team visibility gaps.
- Sound like you noticed something about their setup — not like you're pitching.
- NEVER start with a greeting or the lead's name.
- NEVER reference when they signed up or createdate.
- Keep under 200 characters.

GOOD examples (vary your style — don't copy these):
- "Noticed your team at *Acme* uses *HubSpot* — curious how you handle the gap between WhatsApp conversations and what actually shows up in the CRM."
- "Sales teams running *Salesforce* usually have the CRM nailed down but still lose context from WhatsApp conversations that never get logged."
- "When your team at *Acme* closes deals on WhatsApp but *Zoho* doesn't reflect any of it, tracking pipeline progress becomes guesswork."`,

    // Track B prompt (Low Signal: missing key enrichment data)
    TRACK_B_PROMPT: `Write a broadly relevant WhatsApp snippet for this lead. Data is limited, so keep it general but still human and relatable.

Available lead data:
{{LEAD_DATA}}

INSTRUCTIONS:
- Use whatever context is available (industry, country, company name, CRM) to frame a relatable observation about teams managing WhatsApp conversations alongside their CRM.
- If you have a CRM name, anchor the message around that CRM experience.
- If you have country or region, reference how teams there rely on WhatsApp for business.
- If you have industry, reference industry-specific WhatsApp usage patterns.
- NEVER start with a greeting or the lead's name.
- NEVER reference when they signed up or createdate.
- Sound like you're sharing an observation you've heard from similar teams — not selling.
- Keep under 200 characters.

GOOD examples (vary your style):
- "Teams using *HubSpot* say the trickiest part isn't the CRM — it's that their best conversations live on WhatsApp and never make it into the pipeline."
- "In automotive, WhatsApp is basically the new showroom floor — but getting those chats to sync with your CRM is still a headache most teams live with."
- "Most sales teams we talk to have their CRM dialed in but still lose track of what's actually happening in WhatsApp conversations."`,
};
