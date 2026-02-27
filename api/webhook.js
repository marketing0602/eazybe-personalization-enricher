const { enrichContact } = require('../src/enricher');
const { fetchSingleContact } = require('../src/hubspot');
const config = require('../config');

// A Vercel Serverless Function to accept HubSpot Webhooks
module.exports = async (req, res) => {
    // Only accept POST requests
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        console.log('Webhook received:', JSON.stringify(req.body));

        // HubSpot webhooks usually send an array of events
        const events = req.body;

        if (!Array.isArray(events) || events.length === 0) {
            return res.status(400).json({ error: 'Invalid payload expected an array of events' });
        }

        // We immediately respond so HubSpot doesn't timeout,
        // but we process the contact asynchronously
        res.status(200).json({ status: 'Processing started' });

        // Process each event (usually just 1 for a new contact enrollment)
        for (const event of events) {
            const objectId = event.objectId;
            if (!objectId) continue;

            console.log(`Processing contact ID: ${objectId}`);

            try {
                // Fetch the contact data from HubSpot
                const propertiesToFetch = config.HUBSPOT_PROPERTIES_TO_FETCH;
                if (!propertiesToFetch.includes(config.PERSONALIZATION_FIELD)) {
                    propertiesToFetch.push(config.PERSONALIZATION_FIELD);
                }

                const contact = await fetchSingleContact(objectId, propertiesToFetch);
                if (!contact) {
                    console.log(`Contact ${objectId} not found in HubSpot.`);
                    continue;
                }

                console.log(`Data for ${objectId}:`, contact.properties.phone || contact.properties.email || 'No identifiers');

                // Run enrichment & personalization
                // We use skipPersonalization=false here since this is live operation
                const result = await enrichContact(contact, false);
                console.log(`Finished processing ${objectId}:`, result);

            } catch (err) {
                console.error(`Error processing contact ${objectId}:`, err);
            }
        }

    } catch (err) {
        console.error('Webhook error:', err);
        // If we fail before sending the 200 OK, send a 500
        if (!res.headersSent) {
            res.status(500).json({ error: 'Internal Server Error' });
        }
    }
};
