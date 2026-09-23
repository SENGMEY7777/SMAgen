const Joi = require('joi');

const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^\w\s]).{8,128}$/;
const FULL_NAME_REGEX = /^[\p{L}]+(?:[' -][\p{L}]+)*$/u;
const PHONE_REGEX = /^\+?[1-9]\d{7,14}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_REGEX = /^[A-Za-z0-9_-]{32,512}$/;
const NODE_KEY_REGEX = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const TOOL_NAME_REGEX = /^[A-Za-z][A-Za-z0-9_-]{1,63}$/;
const CONTROL_CHARACTER_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const SENSITIVE_DATA_PATTERNS = [
    /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/i,
    /\b(?:sk_(?:live|test|omni)|AIza|ghp_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{12,}\b/,
    /\bBearer\s+[A-Za-z0-9._-]{20,}\b/i,
    /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*["']?[^\s,"']{8,}/i,
];

const containsSensitiveData = (value) => {
    return SENSITIVE_DATA_PATTERNS.some((pattern) => pattern.test(String(value)));
};

const secureText = ({min = 1, max = 255} = {}) => {
    return Joi.string()
        .trim()
        .min(min)
        .max(max)
        .custom((value, helpers) => {
            if (CONTROL_CHARACTER_REGEX.test(value)) {
                return helpers.error('string.controlCharacters');
            }

            if (containsSensitiveData(value)) {
                return helpers.error('string.sensitiveData');
            }

            return value;
        })
        .messages({
            'string.controlCharacters': '{{#label}} contains invalid control characters',
            'string.sensitiveData': '{{#label}} must not contain secrets or credentials',
        });
};

const secureObject = ({max = 50} = {}) => {
    return Joi.object()
        .max(max)
        .custom((value, helpers) => {
            if (containsSensitiveData(JSON.stringify(value))) {
                return helpers.error('object.sensitiveData');
            }

            return value;
        })
        .messages({
            'object.sensitiveData': '{{#label}} must not contain secrets or credentials',
        });
};

const email = () => Joi.string()
    .trim()
    .lowercase()
    .max(191)
    .pattern(EMAIL_REGEX)
    .messages({
        'string.pattern.base': '{{#label}} must be a valid email address',
    });

const password = () => Joi.string()
    .min(8)
    .max(128)
    .pattern(PASSWORD_REGEX)
    .messages({
        'string.pattern.base': '{{#label}} must contain uppercase, lowercase, number, and special character',
    });

const uuid = () => Joi.string()
    .pattern(UUID_REGEX)
    .messages({
        'string.pattern.base': '{{#label}} must be a valid UUID',
    });

const optionalUuid = () => uuid().allow(null);

const verificationToken = () => Joi.string()
    .trim()
    .pattern(TOKEN_REGEX)
    .messages({
        'string.pattern.base': '{{#label}} is invalid or has an invalid length',
    });

const fullName = () => Joi.string()
    .trim()
    .min(2)
    .max(70)
    .pattern(FULL_NAME_REGEX)
    .messages({
        'string.pattern.base': '{{#label}} can only contain letters, spaces, hyphens, and apostrophes',
    });

const phone = () => Joi.string()
    .trim()
    .pattern(PHONE_REGEX)
    .messages({
        'string.pattern.base': '{{#label}} must use a valid international phone format',
    });

const url = () => Joi.string()
    .trim()
    .max(500)
    .uri({scheme: ['http', 'https']})
    .custom((value, helpers) => {
        if (containsSensitiveData(value)) {
            return helpers.error('string.sensitiveData');
        }

        return value;
    })
    .messages({
        'string.uri': '{{#label}} must be a valid HTTP or HTTPS URL',
        'string.sensitiveData': '{{#label}} must not contain secrets or credentials',
    });

const emptyBodySchema = Joi.object({}).unknown(false);

module.exports = {
    EMAIL_REGEX,
    PASSWORD_REGEX,
    FULL_NAME_REGEX,
    PHONE_REGEX,
    UUID_REGEX,
    NODE_KEY_REGEX,
    TOOL_NAME_REGEX,
    containsSensitiveData,
    secureText,
    secureObject,
    email,
    password,
    uuid,
    optionalUuid,
    verificationToken,
    fullName,
    phone,
    url,
    emptyBodySchema,
};
