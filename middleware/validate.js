'use strict';

const { ValidationError } = require('../utils/errors');

const isJoiSchema = (obj) => {
  return Boolean(obj && (obj.isJoi || typeof obj.validate === 'function'));
};

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
    const errorDetails = error.details.map((detail) => ({
      field: `${source}.${detail.path.join('.')}`,
      message: detail.message.replace(/"/g, ''),
      type: detail.type,
    }));
    const message = error.details.map((d) => d.message.replace(/"/g, '')).join(', ');
    return next(new ValidationError(errorDetails, message));
  }

  if (source === 'body') {
    req.body = value;
  } else {
    req[source] = value;
    req.validated = req.validated || {};
    req.validated[source] = value;
  }

  return next();
};

const validate = (target) => {
  if (isJoiSchema(target)) {
    return validateRequest(target, 'body');
  }

  if (target && typeof target === 'object') {
    return (req, res, next) => {
      const locations = ['params', 'query', 'body', 'headers'];
      const errors = [];

      for (const loc of locations) {
        if (target[loc] && isJoiSchema(target[loc])) {
          const input = loc === 'body' ? (req.body || {}) : (req[loc] || {});
          const { error, value } = target[loc].validate(input, {
            abortEarly: false,
            allowUnknown: false,
            stripUnknown: false,
            convert: true,
          });

          if (error) {
            error.details.forEach((d) => {
              errors.push({
                field: `${loc}.${d.path.join('.')}`,
                message: d.message.replace(/"/g, ''),
                type: d.type,
              });
            });
          } else {
            if (loc === 'body') {
              req.body = value;
            } else {
              req[loc] = value;
              req.validated = req.validated || {};
              req.validated[loc] = value;
            }
          }
        }
      }

      if (errors.length > 0) {
        const message = errors.map((e) => e.message).join(', ');
        return next(new ValidationError(errors, message));
      }

      return next();
    };
  }

  return (req, res, next) => next();
};

const validateQuery = (schema) => validateRequest(schema, 'query');
const validateParams = (schema) => validateRequest(schema, 'params');

module.exports = validate;
module.exports.validate = validate;
module.exports.validateQuery = validateQuery;
module.exports.validateParams = validateParams;
