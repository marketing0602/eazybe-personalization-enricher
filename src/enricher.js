/**
 * Enrichment & Personalization Orchestrator
 *
 * For each HubSpot contact:
 *   1. Check which fields are empty and need enrichment
 *   2. Call Apollo People Enrichment
 *   3. Optionally call Apollo Org Enrichment (for CRM tech stack)
 *   4. Map Apollo data → HubSpot properties
 *   5. Detect language from phone code (if not already set)
 *   6. Generate personalized WhatsApp snippet in the lead's language
 *   7. Push enriched data + snippet to HubSpot
 */
const config = require('../config');
const { enrichPerson } = require('./apollo');
const { generateSnippet, validateSnippet } = require('./anthropic');
const { updateContact } = require('./hubspot');
const { logger, deepGet } = require('./utils');

/**
 * Detect language from phone number country code
 *
 * Handles phones with or without '+' prefix.
 * Falls back to English if no match.
 *
 * @param {object} props - Contact properties
 * @returns {string} 'Portuguese' | 'Spanish' | 'English'
 */
function detectLanguageFromPhone(props) {
    const phone = props.phone || props.mobilephone || '';
    if (!phone) return 'English';

    // Normalize: strip spaces, dashes, parentheses, ensure starts with +
    let clean = phone.replace(/[\s\-()\.\u00a0]/g, '');
    if (!clean.startsWith('+')) clean = '+' + clean;

    // Brazil → Portuguese
    for (const code of config.BRAZIL_PHONE_CODES) {
        if (clean.startsWith(code)) return 'Portuguese';
    }

    // LATAM → Spanish (sort by longest code first to match +1809 before +1)
    const sortedLatam = [...config.LATAM_PHONE_CODES].sort((a, b) => b.length - a.length);
    for (const code of sortedLatam) {
        if (clean.startsWith(code)) return 'Spanish';
    }

    return 'English';
}

/**
 * Normalize any language value to our 3 supported languages.
 * Maps Portuguese/Brazilian variants → Portuguese
 * Maps Spanish/LATAM variants → Spanish
 * Everything else → English
 *
 * @param {string} lang - Raw language string from HubSpot/Apollo
 * @returns {string} 'Portuguese' | 'Spanish' | 'English'
 */
function normalizeLanguage(lang) {
    if (!lang) return null;
    const lower = lang.toLowerCase().trim();

    // Portuguese variants
    if (lower.includes('portug') || lower.includes('brasileiro') || lower === 'pt' || lower === 'pt-br') {
        return 'Portuguese';
    }

    // Spanish variants
    if (lower.includes('spanish') || lower.includes('español') || lower.includes('espanol') || lower === 'es') {
        return 'Spanish';
    }

    // English variants
    if (lower.includes('english') || lower === 'en' || lower === 'en-us' || lower === 'en-gb') {
        return 'English';
    }

    // Any other language (Arabic, Hindi, etc.) → default to English for Eazybe's market
    return 'English';
}

/**
 * Detect country from phone number country code
 *
 * @param {object} props - Contact properties
 * @returns {string|null} Country name or null if no match
 */
function detectCountryFromPhone(props) {
    const phone = props.phone || props.mobilephone || '';
    if (!phone) return null;

    let clean = phone.replace(/[\s\-()\. ]/g, '');
    if (!clean.startsWith('+')) clean = '+' + clean;

    // Sort codes by length (longest first) to match +593 before +5, +1809 before +1
    const codes = Object.keys(config.PHONE_TO_COUNTRY).sort((a, b) => b.length - a.length);
    for (const code of codes) {
        if (clean.startsWith(code)) return config.PHONE_TO_COUNTRY[code];
    }

    return null;
}

/**
 * Determine which HubSpot fields are empty and need enrichment
 *
 * @param {object} properties - Current HubSpot contact properties
 * @returns {Array} Field map entries that need enrichment
 */
function getFieldsToEnrich(properties) {
    return config.FIELD_MAP.filter((field) => {
        const currentVal = properties[field.hubspotProperty];
        // Consider empty: null, undefined, empty string
        return !currentVal || currentVal.toString().trim() === '';
    });
}

/**
 * Enrich a single contact and generate personalized snippet
 *
 * @param {object} contact - HubSpot contact { id, properties }
 * @param {object} opts
 * @param {boolean} opts.dryRun - If true, don't write to HubSpot
 * @param {boolean} opts.skipPersonalization - If true, skip snippet generation
 * @returns {Promise<object>} Result with enrichment + personalization stats
 */
async function enrichContact(contact, { dryRun = false, skipPersonalization = false } = {}) {
    const props = contact.properties || {};
    const name = `${props.firstname || ''} ${props.lastname || ''}`.trim() || `ID:${contact.id}`;

    const result = {
        contactId: contact.id,
        name,
        fieldsUpdated: 0,
        skipped: false,
        notFound: false,
        error: null,
        snippetGenerated: false,
        snippetTrack: null,
        language: null,
    };

    // Step 1: Check what needs enrichment
    const fieldsNeeded = getFieldsToEnrich(props);

    // Personalization: always generate if overwrite is on, otherwise only if empty
    // BUT: skip if no phone number exists (no WhatsApp = no point)
    const hasPhone = !!(props.phone || props.mobilephone);
    const hasExistingSnippet = props[config.PERSONALIZATION_FIELD] &&
        props[config.PERSONALIZATION_FIELD].toString().trim() !== '';
    const needsPersonalization = !skipPersonalization && hasPhone &&
        (config.OVERWRITE_PERSONALIZED_TEXT || !hasExistingSnippet);

    if (!hasPhone && !skipPersonalization) {
        logger.info(`  📵 ${name} — no phone number, skipping personalization`);
    }

    if (fieldsNeeded.length === 0 && !needsPersonalization) {
        logger.info(`  ⏭  ${name} — all fields populated & snippet exists, skipping`);
        result.skipped = true;
        return result;
    }

    const needs = fieldsNeeded.map((f) => f.label);
    if (needsPersonalization) needs.push(hasExistingSnippet ? 'Personalized Text (overwrite)' : 'Personalized Text');
    logger.info(`  🔍 ${name} — needs: ${needs.join(', ')}`);

    // Step 2: Apollo Enrichment (only if data fields are missing)
    const updates = {};
    let apolloData = null;

    if (fieldsNeeded.length > 0) {
        try {
            apolloData = await enrichPerson(contact);
        } catch (err) {
            logger.error(`  ❌ ${name} — Apollo enrichment failed: ${err.message}`);
            // Don't bail — we can still try personalization with existing data
        }

        if (apolloData) {
            // Step 3: Map Apollo data → HubSpot properties
            for (const field of fieldsNeeded) {
                const value = deepGet(apolloData, field.apolloPath);
                let processed = value;

                if (processed != null && field.transform) {
                    processed = field.transform(processed);
                }

                if (processed != null && processed !== '') {
                    updates[field.hubspotProperty] = String(processed);
                }
            }
        }
    }

    // Step 4: Country + Language detection from phone codes (if not already set)
    const mergedProps = { ...props, ...updates };

    // Country detection
    const existingCountry = mergedProps.country;
    if (!existingCountry || existingCountry.trim() === '') {
        const detectedCountry = detectCountryFromPhone(mergedProps);
        if (detectedCountry) {
            updates.country = detectedCountry;
            logger.info(`  🗺  ${name} — country detected from phone: ${detectedCountry}`);
        }
    }

    // Language detection
    let language = null;

    // Priority 1: Existing/enriched language (normalize to our 3 supported)
    const rawLang = mergedProps.language;
    if (rawLang && rawLang.trim() !== '') {
        language = normalizeLanguage(rawLang);
        // If normalization changed the value, update it
        if (language !== rawLang) {
            updates.language = language;
            logger.info(`  🌐 ${name} — language normalized: "${rawLang}" → ${language}`);
        }
    }

    // Priority 2: Phone country code detection
    if (!language) {
        language = detectLanguageFromPhone(mergedProps);
        updates.language = language;
        logger.info(`  🌐 ${name} — language detected from phone: ${language}`);
    }
    result.language = language;

    // Step 6: Personalization snippet generation (in the lead's language)
    if (needsPersonalization) {
        try {
            const genResult = await generateSnippet(mergedProps, { language });

            if (genResult) {
                const validation = validateSnippet(genResult.snippet);

                if (validation.valid) {
                    updates[config.PERSONALIZATION_FIELD] = genResult.snippet;
                    result.snippetGenerated = true;
                    result.snippetTrack = genResult.track;
                    logger.success(`  💬 ${name} — Track ${genResult.track} snippet [${language}] (${genResult.snippet.length} chars)`);
                } else {
                    // Retry with stricter prompt
                    logger.warn(`  ⚠  ${name} — snippet failed validation: ${validation.violations.join(', ')}. Retrying...`);

                    const retryResult = await generateSnippet(mergedProps, { isRetry: true, language });
                    if (retryResult) {
                        const retryValidation = validateSnippet(retryResult.snippet);
                        if (retryValidation.valid) {
                            updates[config.PERSONALIZATION_FIELD] = retryResult.snippet;
                            result.snippetGenerated = true;
                            result.snippetTrack = retryResult.track;
                            logger.success(`  💬 ${name} — Track ${retryResult.track} snippet on retry [${language}] (${retryResult.snippet.length} chars)`);
                        } else {
                            logger.error(`  ❌ ${name} — snippet still invalid after retry: ${retryValidation.violations.join(', ')}. Skipping.`);
                        }
                    }
                }
            } else {
                logger.warn(`  ⚠  ${name} — no snippet generated (AI returned empty)`);
            }
        } catch (err) {
            logger.error(`  ❌ ${name} — personalization error: ${err.message}`);
        }
    }

    // Step 7: Write to HubSpot
    const updateCount = Object.keys(updates).length;

    if (updateCount === 0) {
        logger.info(`  ➖ ${name} — no updates to push`);
        return result;
    }

    if (dryRun) {
        const snippet = updates[config.PERSONALIZATION_FIELD];
        const dataUpdates = { ...updates };
        delete dataUpdates[config.PERSONALIZATION_FIELD];

        if (Object.keys(dataUpdates).length > 0) {
            logger.dry(`  📝 ${name} — WOULD UPDATE ${Object.keys(dataUpdates).length} data fields:`, dataUpdates);
        }
        if (snippet) {
            logger.dry(`  📝 ${name} — WOULD SET personalized_text [${language}]: "${snippet}"`);
        }
    } else {
        try {
            await updateContact(contact.id, updates);
            logger.success(`  ✅ ${name} — updated ${updateCount} fields: ${Object.keys(updates).join(', ')}`);
        } catch (err) {
            const errDetail = err.response?.data;
            logger.error(`  ❌ ${name} — HubSpot update failed: ${err.message}`, {
                payload: updates,
                hubspotError: errDetail,
            });
            result.error = err.message;
            return result;
        }
    }

    result.fieldsUpdated = updateCount;
    return result;
}

module.exports = { enrichContact, getFieldsToEnrich, detectLanguageFromPhone };
