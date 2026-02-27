/**
 * Utility helpers: logging, retry, rate limiting, deep get
 */
const fs = require('fs');
const path = require('path');

// ── Logger ────────────────────────────────────────────────────
const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const today = new Date().toISOString().split('T')[0];
const logFile = path.join(logsDir, `enrichment_${today}.log`);
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

function log(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level}] ${message}${data ? ' | ' + JSON.stringify(data) : ''}`;

    // Console output (colored)
    const colors = { INFO: '\x1b[36m', WARN: '\x1b[33m', ERROR: '\x1b[31m', SUCCESS: '\x1b[32m', DRY: '\x1b[35m' };
    const reset = '\x1b[0m';
    console.log(`${colors[level] || ''}${line}${reset}`);

    // File output
    logStream.write(line + '\n');
}

const logger = {
    info: (msg, data) => log('INFO', msg, data),
    warn: (msg, data) => log('WARN', msg, data),
    error: (msg, data) => log('ERROR', msg, data),
    success: (msg, data) => log('SUCCESS', msg, data),
    dry: (msg, data) => log('DRY', msg, data),
};

// ── Deep get ──────────────────────────────────────────────────
// Safely access nested properties using dot notation
// e.g., deepGet(obj, 'person.organization.name')
function deepGet(obj, path) {
    if (!obj || !path) return undefined;
    return path.split('.').reduce((acc, key) => {
        if (acc == null) return undefined;
        return acc[key];
    }, obj);
}

// ── Sleep ─────────────────────────────────────────────────────
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Retry with exponential backoff ────────────────────────────
async function withRetry(fn, { maxRetries = 3, baseDelay = 2000, label = 'API call' } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            const status = err.response?.status;

            // Don't retry on 4xx client errors (except 429 rate limit)
            if (status && status >= 400 && status < 500 && status !== 429) {
                throw err;
            }

            if (attempt < maxRetries) {
                const delay = baseDelay * Math.pow(2, attempt - 1);
                logger.warn(`${label} failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`, {
                    status,
                    message: err.message,
                });
                await sleep(delay);
            }
        }
    }
    throw lastError;
}

// ── Progress bar helper ───────────────────────────────────────
function progressLine(current, total, name) {
    const pct = Math.round((current / total) * 100);
    const bar = '█'.repeat(Math.floor(pct / 5)) + '░'.repeat(20 - Math.floor(pct / 5));
    return `[${bar}] ${pct}% (${current}/${total}) — ${name}`;
}

module.exports = { logger, deepGet, sleep, withRetry, progressLine };
