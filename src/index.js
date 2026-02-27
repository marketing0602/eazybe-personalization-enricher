/**
 * Eazybe Lead Enrichment & Personalization Agent
 *
 * CLI entry point.
 *
 * Usage:
 *   node src/index.js                              # Full run (enrich + personalize)
 *   node src/index.js --dry-run                    # Preview only, no HubSpot writes
 *   node src/index.js --limit 5                    # Process only first 5 contacts
 *   node src/index.js --since 2026-02-15           # Custom date filter
 *   node src/index.js --skip-personalization       # Enrichment only (no AI)
 *   node src/index.js --dry-run --limit 5          # Test mode
 */
require('dotenv').config();

const config = require('../config');
const { fetchContacts } = require('./hubspot');
const { enrichContact } = require('./enricher');
const { logger, sleep, progressLine } = require('./utils');

// ── Parse CLI arguments ───────────────────────────────────────
function parseArgs() {
    const args = process.argv.slice(2);
    const opts = {
        dryRun: false,
        limit: null,
        since: config.DEFAULT_CREATED_AFTER,
        skipPersonalization: false,
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--dry-run':
                opts.dryRun = true;
                break;
            case '--limit':
                opts.limit = parseInt(args[++i], 10);
                break;
            case '--since':
                opts.since = new Date(args[++i]).toISOString();
                break;
            case '--skip-personalization':
                opts.skipPersonalization = true;
                break;
            case '--help':
                console.log(`
Eazybe Lead Enrichment & Personalization Agent

Usage:
  node src/index.js [options]

Options:
  --dry-run                Preview changes without writing to HubSpot
  --limit N                Process only the first N contacts
  --since DATE             Only contacts created after this date (YYYY-MM-DD)
  --skip-personalization   Skip AI snippet generation, only run Apollo enrichment
  --help                   Show this help message

Examples:
  node src/index.js --dry-run --limit 5
  node src/index.js --since 2026-02-15
  node src/index.js --skip-personalization
  node src/index.js
        `);
                process.exit(0);
        }
    }

    return opts;
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
    const opts = parseArgs();

    console.log('\n');
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║   Eazybe Lead Enrichment & Personalization Agent    ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log('');

    logger.info(`Mode: ${opts.dryRun ? '🧪 DRY RUN (no writes)' : '🚀 LIVE RUN'}`);
    logger.info(`Date filter: contacts created after ${opts.since}`);
    if (opts.limit) logger.info(`Limit: processing first ${opts.limit} contacts only`);
    if (opts.skipPersonalization) {
        logger.info(`Personalization: ⏭ SKIPPED (enrichment only)`);
    } else {
        logger.info(`Personalization: ✅ ENABLED (Sofia → personalized_text)`);
    }
    console.log('');

    // ── Step 1: Fetch contacts from HubSpot ──
    let contacts;
    try {
        contacts = await fetchContacts({
            crmfProperty: config.HUBSPOT_CRMF_PROPERTY,
            createdAfter: opts.since,
            propertiesToFetch: config.HUBSPOT_PROPERTIES_TO_FETCH,
        });
    } catch (err) {
        logger.error(`Failed to fetch contacts from HubSpot: ${err.message}`);
        if (err.response?.data) {
            logger.error('HubSpot error details:', err.response.data);
        }
        process.exit(1);
    }

    if (contacts.length === 0) {
        logger.warn('No contacts found matching the criteria. Nothing to do.');
        process.exit(0);
    }

    // Apply limit if specified
    if (opts.limit && opts.limit < contacts.length) {
        contacts = contacts.slice(0, opts.limit);
        logger.info(`Limited to ${opts.limit} contacts`);
    }

    console.log('');
    logger.info(`Starting enrichment for ${contacts.length} contacts...`);
    console.log('─'.repeat(60));

    // ── Step 2: Enrich + Personalize contacts in batches ──
    const stats = {
        total: contacts.length,
        enriched: 0,
        skipped: 0,
        notFound: 0,
        errors: 0,
        totalFieldsUpdated: 0,
        snippetsGenerated: 0,
        snippetTrackA: 0,
        snippetTrackB: 0,
    };

    for (let i = 0; i < contacts.length; i++) {
        const contact = contacts[i];

        // Progress indicator
        const name = `${contact.properties?.firstname || ''} ${contact.properties?.lastname || ''}`.trim();
        process.stdout.write(`\r${progressLine(i + 1, contacts.length, name || `Contact ${contact.id}`)}`);
        console.log(''); // newline after progress

        const result = await enrichContact(contact, {
            dryRun: opts.dryRun,
            skipPersonalization: opts.skipPersonalization,
        });

        // Update stats
        if (result.error) {
            stats.errors++;
        } else if (result.skipped) {
            stats.skipped++;
        } else if (result.notFound) {
            stats.notFound++;
        } else if (result.fieldsUpdated > 0) {
            stats.enriched++;
            stats.totalFieldsUpdated += result.fieldsUpdated;
        } else {
            stats.skipped++;
        }

        // Track snippet stats
        if (result.snippetGenerated) {
            stats.snippetsGenerated++;
            if (result.snippetTrack === 'A') stats.snippetTrackA++;
            if (result.snippetTrack === 'B') stats.snippetTrackB++;
        }

        // Rate-limit delay between contacts (every batch)
        if ((i + 1) % config.BATCH_SIZE === 0 && i + 1 < contacts.length) {
            logger.info(`  ⏳ Batch pause (${config.BATCH_DELAY_MS}ms)...`);
            await sleep(config.BATCH_DELAY_MS);
        }
    }

    // ── Step 3: Print summary ──
    console.log('');
    console.log('═'.repeat(60));
    console.log('');
    logger.info('📊 ENRICHMENT & PERSONALIZATION SUMMARY');
    console.log('');
    console.log(`   Total contacts processed:  ${stats.total}`);
    console.log(`   ✅ Successfully enriched:  ${stats.enriched}`);
    console.log(`   ⏭  Skipped (already done): ${stats.skipped}`);
    console.log(`   ⚠  Not found on Apollo:   ${stats.notFound}`);
    console.log(`   ❌ Errors:                 ${stats.errors}`);
    console.log(`   📝 Total fields updated:   ${stats.totalFieldsUpdated}`);
    console.log('');
    if (!opts.skipPersonalization) {
        console.log('   ── Personalization ──');
        console.log(`   💬 Snippets generated:     ${stats.snippetsGenerated}`);
        console.log(`   🎯 Track A (High Signal):  ${stats.snippetTrackA}`);
        console.log(`   🌐 Track B (Low Signal):   ${stats.snippetTrackB}`);
        console.log('');
    }

    if (opts.dryRun) {
        logger.warn('This was a DRY RUN — no data was written to HubSpot.');
        logger.info('Run without --dry-run to apply changes.');
    }

    console.log(`📄 Full log saved to: logs/enrichment_${new Date().toISOString().split('T')[0]}.log`);
    console.log('');
}

// ── Run ───────────────────────────────────────────────────────
main().catch((err) => {
    logger.error(`Unhandled error: ${err.message}`);
    console.error(err);
    process.exit(1);
});
