const Joi = require('joi');

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,128}$/;

const loginSchema = Joi.object({
  email: Joi.string()
    .trim()
    .lowercase()
    .pattern(EMAIL_REGEX, 'email format')
    .required()
    .messages({
      'string.empty': 'Email is required',
      'any.required': 'Email is required',
      'string.pattern.name': 'Email format is invalid'
    }),

  password: Joi.string()
    .pattern(PASSWORD_REGEX, 'secure password format')
    .required()
    .messages({
      'string.empty': 'Password is required',
      'any.required': 'Password is required',
      'string.pattern.name': 'Password must contain at least 8 characters, one uppercase letter, one lowercase letter, one number, and one special character (@$!%*?&)'
    })
}).options({ stripUnknown: true });

module.exports = {
  loginSchema,
};