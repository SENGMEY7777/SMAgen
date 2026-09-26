const Joi = require('joi');

const chatMessageSchema = Joi.object({
    role: Joi.string().valid('user', 'assistant').required(),
    content: Joi.string().trim().min(1).max(50000).required(),
}).unknown(true);

const chatSchema = Joi.object({
    message: Joi.string().trim().min(1).max(50000).required(),
    history: Joi.array().items(chatMessageSchema).max(20).default([]),
}).unknown(true);

module.exports = {
    chatSchema,
};
