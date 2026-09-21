const Joi = require('joi');


const FULL_NAME_REGEX = /^[\p{L}]+(?:[' -][\p{L}]+)*$/u;
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,128}$/;

const registerSchema = Joi.object({
  full_name: Joi.string()
    .trim()
    .min(2)
    .max(70)
    .pattern(FULL_NAME_REGEX, 'full name format')
    .required()
    .messages({
      'string.empty': 'Full name is required',
      'string.min': 'Full name must be at least 2 characters',
      'string.max': 'Full name cannot exceed 70 characters',
      'string.pattern.name': 'Full name can only contain letters, spaces, hyphens, and apostrophes'
    }),

  email: Joi.string()
    .trim()
    .lowercase()
    .pattern(EMAIL_REGEX, 'email format')
    .required()
    .messages({
      'string.empty': 'Email is required',
      'string.pattern.name': 'Email format is invalid'
    }),

  password: Joi.string()
    .pattern(PASSWORD_REGEX, 'secure password format')
    .required()
    .messages({
      'string.empty': 'Password is required',
      'string.pattern.name': 'Password must contain at least 8 characters, one uppercase letter, one lowercase letter, one number, and one special character (@$!%*?&)'
    }),

  confirm_password: Joi.string()
    .valid(Joi.ref('password'))
    .required()
    .messages({
      'string.empty': 'Password confirmation is required',
      'any.only': 'Passwords do not match'
    })
}).options({ stripUnknown: true });

module.exports = {
  registerSchema,
};
