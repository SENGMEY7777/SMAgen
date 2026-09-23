const sendResponse = require('../utils/responseHelper');

const validateRequest = (schema, source) => (req, res, next) => {
    if (!schema) {
        return next();
    }

    const input = source === 'body' ? (req.body || {}) : (req[source] || {});
    const { error, value } = schema.validate(input, {
        abortEarly: false,
        allowUnknown: false,
        stripUnknown: false,
        convert: true,
    });

    if (error) {
        const errorMessage = error.details
            .map((detail) => detail.message.replace(/"/g, ''))
            .join(', ');

        return sendResponse(res, 400, false, errorMessage, null, {
            code: 'VALIDATION_ERROR',
        });
    }

    if (source === 'body') {
        req.body = value;
    } else {
        req.validated = req.validated || {};
        req.validated[source] = value;
    }

    return next();
};

const validate = (schema) => validateRequest(schema, 'body');
const validateQuery = (schema) => validateRequest(schema, 'query');
const validateParams = (schema) => validateRequest(schema, 'params');

module.exports = validate;
module.exports.validate = validate;
module.exports.validateQuery = validateQuery;
module.exports.validateParams = validateParams;
