const Joi = require('joi');
const {
    NODE_KEY_REGEX,
    TOOL_NAME_REGEX,
    secureObject,
    secureText,
    uuid,
} = require('../commonValidator');

const workflowCreateSchema = Joi.object({
    title: secureText({min: 3, max: 255}).required(),
    description: secureText({min: 1, max: 5000}).allow(null, ''),
    systemPrompt: secureText({min: 1, max: 20000}).required(),
    isPublic: Joi.boolean().default(false),
}).unknown(false);

const runWorkflowSchema = Joi.object({
    workflowId: uuid().allow(null),
    goalPrompt: secureText({min: 3, max: 20000}).required(),
}).unknown(false);

const resumeWorkflowSchema = Joi.object({}).unknown(false);

const workflowRunParamsSchema = Joi.object({
    runId: uuid().required(),
}).unknown(false);

const taskNodeSchema = Joi.object({
    nodeKey: Joi.string().trim().pattern(NODE_KEY_REGEX).required(),
    title: secureText({min: 1, max: 255}).required(),
    instruction: secureText({min: 1, max: 10000}).required(),
    dependencies: Joi.array()
        .items(Joi.string().trim().pattern(NODE_KEY_REGEX))
        .max(100)
        .unique()
        .default([]),
    assignedTool: Joi.string().trim().pattern(TOOL_NAME_REGEX).required(),
    toolInput: secureObject({max: 50}).default({}),
}).unknown(false);

const dagPlanSchema = Joi.object({
    workflowTitle: secureText({min: 1, max: 255}).required(),
    summary: secureText({min: 1, max: 5000}).required(),
    tasks: Joi.array().items(taskNodeSchema).min(1).max(100).required(),
}).unknown(false);

module.exports = {
    workflowCreateSchema,
    runWorkflowSchema,
    resumeWorkflowSchema,
    workflowRunParamsSchema,
    taskNodeSchema,
    dagPlanSchema,
};
