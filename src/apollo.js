/**
 * Apollo API module
 * - People Enrichment (by phone, email, LinkedIn)
 * - Organization Enrichment (by domain — for technographics)
 */
const axios = require('axios');
const { logger, withRetry, sleep } = require('./utils');
const config = require('../config');

const APOLLO_BASE = 'https://api.apollo.io';

function getApiKey() {
    const key = process.env.APOLLO_API_KEY;
    if (!key) throw new Error('APOLLO_API_KEY is not set in .env');
    return key;
}

/**
 * Enrich a person via Apollo People Match API
 *
 * Sends all available identifiers to maximize match rate:
 *   - phone (always available)
 *   - email (when available)
 *   - linkedin_url (when available)
 *   - first_name, last_name (when available)
 *
 * @param {object} contact - HubSpot contact with properties
 * @returns {Promise<object|null>} Apollo person object or null if not found
 */
async function enrichPerson(contact) {
    const props = contact.properties || {};
    const apiKey = getApiKey();

    // Build the request payload with all available identifiers
    const payload = {
        api_key: apiKey,
        reveal_personal_emails: false,
    };

    // Phone number — primary identifier (always available)
    // Sanitize: strip spaces, dashes, parentheses
    const rawPhone = props.phone || props.mobilephone;
    if (rawPhone) {
        const cleanPhone = rawPhone.replace(/[\s\-\(\)\.]/g, '');
        if (cleanPhone.length >= 7) {
            payload.phone_number = cleanPhone;
        }
    }

    // Email — secondary identifier
    const email = props.email;
    if (email) {
        payload.email = email;
    }

    // LinkedIn URL — strong identifier when available
    const linkedin = props.final_linkedin_link || props.hs_linkedin_url;
    if (linkedin) {
        payload.linkedin_url = linkedin;
    }

    // Name — helps disambiguation
    if (props.firstname) payload.first_name = props.firstname;
    if (props.lastname) payload.last_name = props.lastname;

    // Need at least one identifier
    if (!payload.phone_number && !payload.email && !payload.linkedin_url) {
        logger.warn(`No usable identifier for contact ${contact.id} (${props.firstname} ${props.lastname})`);
        return null;
    }

    try {
        const response = await withRetry(
            () =>
                axios.post(`${APOLLO_BASE}/api/v1/people/match`, payload, {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 30000,
                }),
            { label: `Apollo people match (${props.firstname || ''} ${props.lastname || ''})` }
        );

        await sleep(config.APOLLO_RATE_DELAY_MS);

        const person = response.data?.person;
        if (!person) {
            logger.warn(`Apollo: no match for contact ${contact.id}`);
            return null;
        }

        return { person };
    } catch (err) {
        const status = err.response?.status;
        const errData = err.response?.data;

        // Log detailed error for debugging
        if (errData) {
            logger.warn(`Apollo error detail for contact ${contact.id}:`, errData);
        }

        // Treat 400, 404, 422 as "not found" — don't crash
        if (status === 400 || status === 404 || status === 422) {
            logger.warn(`Apollo: no match for contact ${contact.id} (${status})`);
            return null;
        }
        throw err;
    }
}

/**
 * Enrich an organization via Apollo Org Enrichment API
 * Used primarily to get the technology stack / CRM information
 *
 * @param {string} domain - Company website domain (e.g., "acme.com")
 * @returns {Promise<object|null>} Apollo organization object or null
 */
async function enrichOrganization(domain) {
    if (!domain) return null;

    const apiKey = getApiKey();

    try {
        const response = await withRetry(
            () =>
                axios.get(`${APOLLO_BASE}/api/v1/organizations/enrich`, {
                    params: {
                        api_key: apiKey,
                        domain: domain,
                    },
                    timeout: 30000,
                }),
            { label: `Apollo org enrichment (${domain})` }
        );

        await sleep(config.APOLLO_RATE_DELAY_MS);

        return response.data?.organization || null;
    } catch (err) {
        const status = err.response?.status;
        if (status === 404 || status === 422) {
            logger.warn(`Apollo: no org data for domain ${domain}`);
            return null;
        }
        throw err;
    }
}

/**
 * Extract CRM technology name from an Apollo org's tech stack
 *
 * @param {object} organization - Apollo org object
 * @returns {string|null} Name of detected CRM, or null
 */
function extractCrmTechnology(organization) {
    if (!organization) return null;

    const technologies = organization.current_technologies || [];

    for (const tech of technologies) {
        const name = (tech.name || tech || '').toString().toLowerCase();
        for (const keyword of config.CRM_KEYWORDS) {
            if (name.includes(keyword)) {
                // Return the properly-cased tech name
                return tech.name || tech.toString();
            }
        }
    }

    return null;
}

module.exports = { enrichPerson, enrichOrganization, extractCrmTechnology };
