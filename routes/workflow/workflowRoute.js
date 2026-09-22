const router = require('express').Router();

const workflowController = require('../../controllers/workflow/workflowController');
const isLogin = require('../../middleware/authenticate');

router.post('/create', isLogin, workflowController.create);
router.get('/listWorkflows', isLogin, workflowController.list);

// Workflow Runs
router.post('/run', isLogin, workflowController.runWorkflow);
router.post('/run/:runId', isLogin, workflowController.runWorkflow);
router.get('/runs', isLogin, workflowController.listRuns);
router.get('/runs/:runId', isLogin, workflowController.getWorkflowRun);

module.exports = router;
