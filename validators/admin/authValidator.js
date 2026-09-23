const Joi = require('joi');
const {email, password} = require('../commonValidator');

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

module.exports = {
    loginSchema,
};
