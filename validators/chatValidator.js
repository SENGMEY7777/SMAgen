const Joi = require('joi');
const {secureText} = require('./commonValidator');

const chatMessageSchema = Joi.object({
    role: Joi.string().valid('user', 'assistant').required(),
    content: secureText({min: 1, max: 20000}).required(),
}).unknown(false);

const chatSchema = Joi.object({
    message: secureText({min: 1, max: 20000}).required(),
    history: Joi.array().items(chatMessageSchema).max(12).default([]),
}).unknown(false);

module.exports = {
    chatSchema,
};
