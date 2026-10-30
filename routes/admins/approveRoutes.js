const router = require('express').Router();

const approveController = require('../../controllers/admins/approveController');
const authenticate = require('../../middleware/authenticate');
const requireRole = require('../../middleware/authorize');
const validate = require('../../middleware/validate');
const {workflowReadLimiter} = require('../../middleware/rateLimiters');
const {
    approvalIdParamsSchema,
    pendingApprovalsQuerySchema,
    approvalDecisionSchema,
} = require('../../validators/admin/approveValidator');

router.use(authenticate);

router.get('/pending', workflowReadLimiter, requireRole('ADMIN', 'OPERATOR', 'DEVELOPER'), validate.validateQuery(pendingApprovalsQuerySchema), approveController.listPending);
router.get('/:id', workflowReadLimiter, requireRole('ADMIN', 'OPERATOR', 'DEVELOPER'), validate.validateParams(approvalIdParamsSchema), approveController.getById);
router.post('/:id/decision', requireRole('ADMIN', 'OPERATOR', 'DEVELOPER'), validate.validateParams(approvalIdParamsSchema), validate(approvalDecisionSchema), approveController.decide);

module.exports = router;
