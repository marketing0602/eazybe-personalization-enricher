require('dotenv').config();
const { enrichContact } = require('./enricher');
const { fetchContacts } = require('./hubspot');
const config = require('../config');
const { logger } = require('./utils');

async function runCron() {
    try {
        logger.info('======================================================');
        logger.info('Railway Daemon waking up... Checking for new leads');
        logger.info('======================================================');

        // Fetch contacts created in the last 65 minutes
        const createdAfter = new Date(Date.now() - 65 * 60 * 1000).toISOString();
        
        const propertiesToFetch = [...config.HUBSPOT_PROPERTIES_TO_FETCH];
        const contacts = await fetchContacts({
            crmfProperty: null,
            createdAfter: createdAfter,
            propertiesToFetch: propertiesToFetch,
        });

        logger.info(`Found ${contacts.length} recently created contacts.`);

        let processed = 0;
        for (const contact of contacts) {
            logger.info(`Checking contact ID: ${contact.id}`);

            if (contact.properties[config.PERSONALIZATION_FIELD]) {
                logger.info(`Skipping ${contact.id}: already has personalized_text`);
                continue;
            }

            try {
                await enrichContact(contact, { dryRun: false, skipPersonalization: false });
                processed++;
            } catch (err) {
                logger.error(`Error processing contact ${contact.id}: ${err.message}`);
            }
        }
        
        logger.info(`Daemon cycle complete. Processed ${processed} new contacts.`);
        logger.info('Sleeping for 1 hour until next cycle...');
        logger.info('======================================================\n');
    } catch (err) {
        logger.error(`Daemon cycle failed: ${err.message}`);
    }
}

// Run the first check immediately when Railway spins up the container
runCron();

// Run continuously every 60 minutes (3600000 milliseconds)
setInterval(runCron, 60 * 60 * 1000);
