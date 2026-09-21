const sendResponse = require('../utils/responseHelper');

const validate = (schema) => (req, res, next) => {
    if (!schema) {
        return next();
    }

    const { error, value } = schema.validate(req.body, {
        abortEarly: false,
        stripUnknown: true,
    });

    if (error) {
        const errorMessage = error.details.map((detail) => detail.message.replace(/\"/g, '')).join(', ');
        return sendResponse(res, 400, false, errorMessage);
    }

    req.body = value;
    return next();
};

module.exports = validate;
