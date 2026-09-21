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
    .messages({
      'string.empty': 'Full name is required',
      'any.required': 'Full name is required',
      'string.min': 'Full name must be at least 2 characters',
      'string.max': 'Full name cannot exceed 70 characters',
      'string.pattern.name': 'Full name can only contain letters, spaces, hyphens, and apostrophes'
    }),

  fullName: Joi.string()
    .trim()
    .min(2)
    .max(70)
    .pattern(FULL_NAME_REGEX, 'full name format'),

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
    .messages({
      'string.empty': 'Password is required',
      'any.required': 'Password is required',
      'string.pattern.name': 'Password must contain at least 8 characters, one uppercase letter, one lowercase letter, one number, and one special character (@$!%*?&)'
    }),

  password_hash: Joi.string()
    .pattern(PASSWORD_REGEX, 'secure password format'),

  phone_number: Joi.string().allow(null, ''),
  phoneNumber: Joi.string().allow(null, ''),
  gender: Joi.string().valid('MALE', 'FEMALE', 'OTHER').allow(null, ''),
  avatar_url: Joi.string().allow(null, ''),
  avatarUrl: Joi.string().allow(null, ''),
})
.xor('full_name', 'fullName')
.xor('password', 'password_hash')
.messages({
  'object.missing': 'Required fields missing',
})
.options({ stripUnknown: true });

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

  password: Joi.string().messages({
    'string.empty': 'Password is required',
    'any.required': 'Password is required'
  }),

  password_hash: Joi.string()
})
.xor('password', 'password_hash')
.messages({
  'object.missing': 'Password is required',
})
.options({ stripUnknown: true });

module.exports = {
  registerSchema,
  loginSchema,
};
