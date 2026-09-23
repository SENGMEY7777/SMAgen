const Joi = require('joi');

const {
    secureText,
    uuid,
} = require('../commonValidator');

const approvalIdParamsSchema = Joi.object({
    id: uuid().required(),
}).unknown(false);

const pendingApprovalsQuerySchema = Joi.object({
    runId: uuid().optional(),
}).unknown(false);

const approvalDecisionSchema = Joi.object({
    status: Joi.string()
        .valid('APPROVED', 'REJECTED')
        .required(),
    rejectionReason: secureText({min: 1, max: 2000})
        .allow(null, '')
        .optional(),
})
    .custom((value, helpers) => {
        if (value.status === 'REJECTED' && !String(value.rejectionReason || '').trim()) {
            return helpers.error('any.rejectionReasonRequired');
        }

        if (value.status === 'APPROVED' && value.rejectionReason) {
            return helpers.error('any.rejectionReasonNotAllowed');
        }

        return value;
    })
    .messages({
        'any.rejectionReasonRequired': 'rejectionReason is required when rejecting an approval request',
        'any.rejectionReasonNotAllowed': 'rejectionReason must not be sent when approving an approval request',
    })
    .unknown(false);

module.exports = {
    approvalIdParamsSchema,
    pendingApprovalsQuerySchema,
    approvalDecisionSchema,
};
