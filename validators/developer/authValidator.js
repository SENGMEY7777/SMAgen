const Joi = require('joi');
const {
    email,
    fullName,
    password,
    phone,
    url,
    verificationToken,
} = require('../commonValidator');

const registerSchema = Joi.object({
    full_name: fullName(),
    fullName: fullName(),
    email: email().required().messages({
        'string.empty': 'Email is required',
        'any.required': 'Email is required',
    }),
    password: password().required().messages({
        'string.empty': 'Password is required',
        'any.required': 'Password is required',
    }),
    phone_number: phone().allow(null, ''),
    phoneNumber: phone().allow(null, ''),
    gender: Joi.string().valid('MALE', 'FEMALE', 'OTHER').allow(null, ''),
    avatar_url: url().allow(null, ''),
    avatarUrl: url().allow(null, ''),
})
    .xor('full_name', 'fullName')
    .unknown(false)
    .messages({
        'object.xor': 'Use exactly one of full_name or fullName',
    });

const loginSchema = Joi.object({
    email: email().required().messages({
        'string.empty': 'Email is required',
        'any.required': 'Email is required',
    }),
    password: password().required().messages({
        'string.empty': 'Password is required',
        'any.required': 'Password is required',
    }),
}).unknown(false);

const verificationTokenSchema = Joi.object({
    token: verificationToken().required(),
}).unknown(false);

const resendVerificationSchema = Joi.object({
    email: email().required().messages({
        'string.empty': 'Email is required',
        'any.required': 'Email is required',
    }),
}).unknown(false);

module.exports = {
    registerSchema,
    loginSchema,
    verificationTokenSchema,
    resendVerificationSchema,
};
