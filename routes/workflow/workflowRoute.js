const router = require('express').Router();

const workflowController = require('../../controllers/workflow/workflowController');
const isLogin = require('../../middleware/authenticate');
const {workflowRunLimiter} = require('../../middleware/rateLimiters');
const validate = require('../../middleware/validate');
const {validateParams} = require('../../middleware/validate');
const {
    workflowCreateSchema,
    runWorkflowSchema,
    resumeWorkflowSchema,
    workflowRunParamsSchema,
} = require('../../validators/workflow/workflowValidator');

router.post('/create', isLogin, validate(workflowCreateSchema), workflowController.create);
router.get('/listWorkflows', isLogin, workflowController.list);

// Workflow Runs
router.post(
    '/run',
    isLogin,
    workflowRunLimiter,
    validate(runWorkflowSchema),
    workflowController.runWorkflow,
);
router.post(
    '/run/stream',
    isLogin,
    workflowRunLimiter,
    validate(runWorkflowSchema),
    workflowController.runWorkflowStream,
);
router.post(
    '/run/:runId',
    isLogin,
    workflowRunLimiter,
    validateParams(workflowRunParamsSchema),
    validate(resumeWorkflowSchema),
    workflowController.runWorkflow,
);
router.get('/runs', isLogin, workflowController.listRuns);
router.get(
    '/runs/:runId',
    isLogin,
    validateParams(workflowRunParamsSchema),
    workflowController.getWorkflowRun,
);

module.exports = router;
