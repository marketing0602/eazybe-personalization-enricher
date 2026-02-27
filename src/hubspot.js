/**
 * HubSpot API module
 * - Fetch contacts via CRM Search API (with filters)
 * - Update individual contact properties
 */
const axios = require('axios');
const { logger, withRetry, sleep } = require('./utils');

const HUBSPOT_BASE = 'https://api.hubapi.com';

function getClient() {
    const apiKey = process.env.HUBSPOT_API_KEY;
    if (!apiKey) throw new Error('HUBSPOT_API_KEY is not set in .env');

    return axios.create({
        baseURL: HUBSPOT_BASE,
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        timeout: 30000,
    });
}

/**
 * Fetch a single contact from HubSpot by ID
 * @param {string} contactId
 * @param {string[]} propertiesToFetch
 * @returns {Promise<object|null>}
 */
async function fetchSingleContact(contactId, propertiesToFetch) {
    const client = getClient();
    try {
        const response = await withRetry(
            () =>
                client.get(`/crm/v3/objects/contacts/${contactId}`, {
                    params: { properties: propertiesToFetch.join(',') },
                }),
            { label: `HubSpot get contact ${contactId}` }
        );
        return {
            id: response.data.id,
            properties: response.data.properties,
        };
    } catch (err) {
        if (err.response?.status === 404) return null;
        throw err;
    }
}

/**
 * Fetch contacts from HubSpot matching:
 *   1. Optionally: CRMF property is known (not empty)
 *   2. Created after a given date
 *
 * If crmfProperty is null, fetches ALL contacts created after the given date.
 *
 * @param {object} opts
 * @param {string|null} opts.crmfProperty - Internal name of CRMF property (null = fetch all)
 * @param {string} opts.createdAfter - ISO date string
 * @param {string[]} opts.propertiesToFetch - Properties to include in response
 * @returns {Promise<Array>} Array of contact objects { id, properties }
 */
async function fetchContacts({ crmfProperty, createdAfter, propertiesToFetch }) {
    const client = getClient();
    const allContacts = [];
    let after = undefined;
    let page = 1;

    const filterLabel = crmfProperty
        ? `CRMF is known, created after ${createdAfter}`
        : `all new leads created after ${createdAfter}`;
    logger.info(`Fetching HubSpot contacts (${filterLabel})...`);

    while (true) {
        // Build filters — always filter by createdate
        const filters = [
            {
                propertyName: 'createdate',
                operator: 'GTE',
                value: new Date(createdAfter).getTime().toString(),
            },
        ];

        // Optionally filter by CRMF property
        if (crmfProperty) {
            filters.push({
                propertyName: crmfProperty,
                operator: 'HAS_PROPERTY',
            });
        }

        const body = {
            filterGroups: [{ filters }],
            properties: propertiesToFetch,
            limit: 100,
            sorts: [{ propertyName: 'createdate', direction: 'ASCENDING' }],
        };

        if (after) {
            body.after = after;
        }

        const response = await withRetry(
            () => client.post('/crm/v3/objects/contacts/search', body),
            { label: `HubSpot search (page ${page})` }
        );

        const { results, paging } = response.data;
        allContacts.push(...results);

        logger.info(`  Page ${page}: fetched ${results.length} contacts (total so far: ${allContacts.length})`);

        if (paging?.next?.after) {
            after = paging.next.after;
            page++;
            await sleep(200); // be nice to HubSpot API
        } else {
            break;
        }
    }

    logger.success(`Fetched ${allContacts.length} contacts from HubSpot`);
    return allContacts;
}

/**
 * Update a single HubSpot contact with new properties
 *
 * @param {string} contactId
 * @param {object} properties - Key-value map of properties to update
 * @returns {Promise<object>}
 */
async function updateContact(contactId, properties) {
    const client = getClient();

    return withRetry(
        () =>
            client.patch(`/crm/v3/objects/contacts/${contactId}`, {
                properties,
            }),
        { label: `HubSpot update contact ${contactId}` }
    );
}

module.exports = { fetchContacts, fetchSingleContact, updateContact };
