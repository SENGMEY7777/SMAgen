'use strict';

const { getCorrelationId } = require('./asyncContext');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };
const LEVEL_THRESHOLD = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;

const serialize = (level, message, meta = {}) => {
    const entry = {
        timestamp: new Date().toISOString(),
        level,
        correlationId: getCorrelationId() || undefined,
        message,
    };

    if (meta instanceof Error) {
        entry.error = {
            name: meta.name,
            message: meta.message,
            code: meta.code || undefined,
            stack: process.env.NODE_ENV !== 'production' ? meta.stack : undefined,
        };
    } else if (meta && typeof meta === 'object' && Object.keys(meta).length > 0) {
        Object.assign(entry, meta);
    }

    return JSON.stringify(entry);
};

const log = (level, message, meta) => {
    if (LEVELS[level] < LEVEL_THRESHOLD) return;
    const output = level === 'error' || level === 'fatal' ? process.stderr : process.stdout;
    output.write(serialize(level, message, meta) + '\n');
};

module.exports = {
    debug: (msg, meta) => log('debug', msg, meta),
    info: (msg, meta) => log('info', msg, meta),
    warn: (msg, meta) => log('warn', msg, meta),
    error: (msg, meta) => log('error', msg, meta),
    fatal: (msg, meta) => log('fatal', msg, meta),
};
