const Joi = require('joi');

const chatMessageSchema = Joi.object({
    role: Joi.string().valid('user', 'assistant').required(),
    content: Joi.string().trim().min(1).max(50000).required(),
}).unknown(true);

const chatSchema = Joi.object({
    message: Joi.string().trim().max(50000).allow('', null).default('Please analyze the attached image.'),
    history: Joi.array().items(chatMessageSchema).max(20).default([]),
    images: Joi.array().items(Joi.string().max(25000000)).max(5).default([]),
    projectContext: Joi.object().unknown(true).allow(null),
    localDestination: Joi.string().allow('', null),
}).unknown(true);

module.exports = {
    chatSchema,
};
