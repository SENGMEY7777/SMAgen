const dotenv = require('dotenv');

dotenv.config();

const DEFAULTS = {
    PORT: '8080',
    DB_PORT: '3306',
    JWT_ISSUER: 'ai-agent-api',
    JWT_AUDIENCE: 'ai-agent-admin',
    JWT_EXPIRES_IN: '15m',
    GEMINI_MODEL: 'gemini-3.1-flash-lite',
    GEMINI_FALLBACK_MODEL: 'gemini-3.8-flash',
    MAX_CONCURRENT_TASKS: '4',
    COMMAND_TIMEOUT_MS: '30000',
    HTTP_REQUEST_TIMEOUT_MS: '10000',
    MAX_SELF_HEAL_RETRIES: '3',
    GEMINI_INPUT_RATE_USD_PER_1M_TOKENS: '0',
    GEMINI_OUTPUT_RATE_USD_PER_1M_TOKENS: '0',
    DB_SSL: 'false',
    DB_SSL_REJECT_UNAUTHORIZED: 'true',
    DB_POOL_LIMIT: '20',
    DB_POOL_MAX_IDLE: '10',
    DB_POOL_IDLE_TIMEOUT_MS: '60000',
};

const PLACEHOLDER_PATTERN = /^(?:your_|replace_with_|change_me|example|xxx|<.+>)|(?:_here$)/i;
const VALID_NODE_ENVS = new Set(['development', 'test', 'production']);

const isBlank = (value) => value === undefined || value === null || !String(value).trim();

const isPlaceholder = (value) => PLACEHOLDER_PATTERN.test(String(value || '').trim());

const parseBoolean = (value, defaultValue = false) => {
    if (isBlank(value)) {
        return defaultValue;
    }

    const normalized = String(value).trim().toLowerCase();

    if (['true', '1', 'yes', 'on'].includes(normalized)) {
        return true;
    }

    if (['false', '0', 'no', 'off'].includes(normalized)) {
        return false;
    }

    return null;
};

const getCorsOrigins = (env = process.env) => {
    return String(env.CORS_ORIGIN || '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);
};

const isLocalDatabaseHost = (host) => {
    return ['localhost', '127.0.0.1', '::1'].includes(String(host || '').trim().toLowerCase());
};

const getValue = (env, key) => {
    return isBlank(env[key]) ? DEFAULTS[key] : env[key];
};

const addIssue = (issues, message) => {
    issues.push(message);
};

const validateInteger = (issues, env, key, {min = 0, max = Number.MAX_SAFE_INTEGER} = {}) => {
    const rawValue = getValue(env, key);
    const value = Number(rawValue);

    if (!Number.isInteger(value) || value < min || value > max) {
        addIssue(issues, `${key} must be an integer between ${min} and ${max}`);
    }
};

const validateNonNegativeNumber = (issues, env, key) => {
    const rawValue = getValue(env, key);
    const value = Number(rawValue);

    if (!Number.isFinite(value) || value < 0) {
        addIssue(issues, `${key} must be a non-negative number`);
    }
};

const validateEnvironment = ({
    env = process.env,
    nodeEnv = String(env.NODE_ENV || 'development').toLowerCase(),
} = {}) => {
    const issues = [];
    const normalizedNodeEnv = String(nodeEnv).trim().toLowerCase();

    if (!VALID_NODE_ENVS.has(normalizedNodeEnv)) {
        addIssue(issues, 'NODE_ENV must be development, test, or production');
    }
    const requiredKeys = [
        'DB_HOST',
        'DB_NAME',
        'DB_USER',
    ];

    for (const key of requiredKeys) {
        if (isBlank(env[key])) {
            addIssue(issues, `${key} is required`);
        } else if (isPlaceholder(env[key])) {
            addIssue(issues, `${key} still contains a placeholder value`);
        }
    }

    const databasePassword = env.DB_PASSWORD || env.DB_PASS;

    if (isBlank(databasePassword)) {
        addIssue(issues, 'DB_PASSWORD or DB_PASS is required');
    } else if (isPlaceholder(databasePassword)) {
        addIssue(issues, 'DB_PASSWORD or DB_PASS still contains a placeholder value');
    }

    if (isBlank(env.JWT_SECRET)) {
        addIssue(issues, 'JWT_SECRET is required');
    } else if (String(env.JWT_SECRET).length < 32) {
        addIssue(issues, 'JWT_SECRET must contain at least 32 characters');
    } else if (isPlaceholder(env.JWT_SECRET)) {
        addIssue(issues, 'JWT_SECRET still contains a placeholder value');
    }

    const geminiApiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;

    if (isBlank(geminiApiKey)) {
        addIssue(issues, 'GEMINI_API_KEY or GOOGLE_API_KEY is required');
    } else if (isPlaceholder(geminiApiKey)) {
        addIssue(issues, 'GEMINI_API_KEY or GOOGLE_API_KEY still contains a placeholder value');
    }

    validateInteger(issues, env, 'PORT', {min: 1, max: 65535});
    validateInteger(issues, env, 'DB_PORT', {min: 1, max: 65535});
    validateInteger(issues, env, 'DB_POOL_LIMIT', {min: 1, max: 100});
    validateInteger(issues, env, 'DB_POOL_MAX_IDLE', {min: 0, max: 100});
    validateInteger(issues, env, 'DB_POOL_IDLE_TIMEOUT_MS', {min: 1000, max: 3600000});
    validateInteger(issues, env, 'MAX_CONCURRENT_TASKS', {min: 1, max: 100});
    validateInteger(issues, env, 'COMMAND_TIMEOUT_MS', {min: 1000, max: 30000});
    validateInteger(issues, env, 'HTTP_REQUEST_TIMEOUT_MS', {min: 1000, max: 300000});
    validateInteger(issues, env, 'MAX_SELF_HEAL_RETRIES', {min: 0, max: 20});
    validateNonNegativeNumber(issues, env, 'GEMINI_INPUT_RATE_USD_PER_1M_TOKENS');
    validateNonNegativeNumber(issues, env, 'GEMINI_OUTPUT_RATE_USD_PER_1M_TOKENS');

    const dbSsl = parseBoolean(env.DB_SSL, false);
    const dbSslRejectUnauthorized = parseBoolean(env.DB_SSL_REJECT_UNAUTHORIZED, true);
    const dbPoolLimit = Number(getValue(env, 'DB_POOL_LIMIT'));
    const dbPoolMaxIdle = Number(getValue(env, 'DB_POOL_MAX_IDLE'));

    if (dbSsl === null) {
        addIssue(issues, 'DB_SSL must be a boolean value');
    }

    if (dbSslRejectUnauthorized === null) {
        addIssue(issues, 'DB_SSL_REJECT_UNAUTHORIZED must be a boolean value');
    }

    if (Number.isInteger(dbPoolLimit) && Number.isInteger(dbPoolMaxIdle) && dbPoolMaxIdle > dbPoolLimit) {
        addIssue(issues, 'DB_POOL_MAX_IDLE cannot exceed DB_POOL_LIMIT');
    }

    if (
        normalizedNodeEnv === 'production'
        && !isLocalDatabaseHost(env.DB_HOST)
        && dbSsl !== true
    ) {
        addIssue(issues, 'DB_SSL=true is required for a remote production database');
    }

    if (normalizedNodeEnv === 'production' && dbSslRejectUnauthorized !== true) {
        addIssue(issues, 'DB_SSL_REJECT_UNAUTHORIZED=true is required in production');
    }

    if (env.SMTP_PORT !== undefined && !isBlank(env.SMTP_PORT)) {
        validateInteger(issues, env, 'SMTP_PORT', {min: 1, max: 65535});
    }

    const smtpUser = env.SMTP_USER || env.EMAIL_USER;
    const smtpPassword = env.SMTP_PASS || env.EMAIL_PASS;

    if (smtpUser && !smtpPassword) {
        addIssue(issues, 'SMTP_PASS or EMAIL_PASS is required when SMTP_USER or EMAIL_USER is configured');
    }

    if (smtpPassword && !smtpUser) {
        addIssue(issues, 'SMTP_USER or EMAIL_USER is required when SMTP_PASS or EMAIL_PASS is configured');
    }

    const corsOrigins = getCorsOrigins(env);
    if (corsOrigins.length === 0) {
        corsOrigins.push('*');
    }

    let appUrl = 'https://kairo-sengmey-dev.duckdns.org';
    if (!isBlank(env.APP_URL)) {
        try {
            const parsed = new URL(String(env.APP_URL).trim());
            appUrl = parsed.origin;
        } catch {
            // keep fallback
        }
    }

    if (issues.length) {
        const error = new Error(`Environment validation failed:\n- ${issues.join('\n- ')}`);
        error.code = 'ENV_CONFIG_ERROR';
        throw error;
    }

    return {
        nodeEnv: normalizedNodeEnv,
        port: Number(getValue(env, 'PORT')),
        corsOrigins,
        emailSimulationAllowed: parseBoolean(env.ALLOW_EMAIL_SIMULATION, false) === true,
        database: {
            host: env.DB_HOST,
            port: Number(getValue(env, 'DB_PORT')),
            name: env.DB_NAME,
            user: env.DB_USER,
            ssl: dbSsl === true,
            sslRejectUnauthorized: dbSslRejectUnauthorized === true,
            pool: {
                connectionLimit: dbPoolLimit,
                maxIdle: dbPoolMaxIdle,
                idleTimeout: Number(getValue(env, 'DB_POOL_IDLE_TIMEOUT_MS')),
            },
        },
        llm: {
            model: getValue(env, 'GEMINI_MODEL'),
            fallbackModel: getValue(env, 'GEMINI_FALLBACK_MODEL'),
        },
    };
};

module.exports = {
    DEFAULTS,
    getCorsOrigins,
    parseBoolean,
    validateEnvironment,
};
