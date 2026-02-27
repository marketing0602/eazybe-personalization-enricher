const { enrichContact } = require('../src/enricher');
const { fetchContacts } = require('../src/hubspot');
const config = require('../config');

// Vercel Cron Job endpoint
module.exports = async (req, res) => {
    try {
        console.log('Cron job started. Checking for new leads...');

        // Fetch all contacts created in the last 30 minutes
        const createdAfter = new Date(Date.now() - 30 * 60 * 1000).toISOString();

        const propertiesToFetch = [...config.HUBSPOT_PROPERTIES_TO_FETCH];

        const contacts = await fetchContacts({
            // Fetch all new leads regardless of property
            crmfProperty: null,
            createdAfter: createdAfter,
            propertiesToFetch: propertiesToFetch,
        });

        console.log(`Found ${contacts.length} recently created contacts.`);

        // Limit processing at once to avoid Vercel Serverless 10-second timeout on free tier
        let contactsToProcess = contacts;
        const MAX_CONTACTS = 10;
        if (contacts.length > MAX_CONTACTS) {
            console.log(`Limiting processing to first ${MAX_CONTACTS} to avoid server timeout.`);
            contactsToProcess = contacts.slice(0, MAX_CONTACTS);
        }

        let processed = 0;
        for (const contact of contactsToProcess) {
            console.log(`Checking contact ID: ${contact.id}`);

            // Skip if already processed (has personalized text)
            if (contact.properties[config.PERSONALIZATION_FIELD]) {
                console.log(`Skipping ${contact.id}: already has personalized_text`);
                continue;
            }

            try {
                // Pass an object to enrichContact matching index.js syntax 
                const result = await enrichContact(contact, { dryRun: false, skipPersonalization: false });
                console.log(`Finished processing ${contact.id}:`);
                processed++;
            } catch (err) {
                console.error(`Error processing contact ${contact.id}:`, err);
            }
        }

        res.status(200).json({ status: 'Success', totalFound: contacts.length, processed });
    } catch (err) {
        console.error('Cron job error:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};
