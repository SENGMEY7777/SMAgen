const rateLimit = require('express-rate-limit');

const rateLimitMessage = (message, code) => ({
    success: false,
    message,
    error: {code},
});

const authAttemptLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: rateLimitMessage(
        'Too many authentication attempts. Please try again later.',
        'AUTH_RATE_LIMITED',
    ),
});

const workflowRunLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 20,
    keyGenerator: (req) => String(req.user.id),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: rateLimitMessage(
        'Workflow run limit reached. Please try again later.',
        'WORKFLOW_RATE_LIMITED',
    ),
});

module.exports = {
    authAttemptLimiter,
    workflowRunLimiter,
};
