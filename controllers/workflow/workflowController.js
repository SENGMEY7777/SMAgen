const workflowService = require('../../services/workflow/workflowService');
const sendResponse = require('../../utils/responseHelper');

const create = async (req, res) => {
    try {
        const body = req.body || {};
        const result = await workflowService.create({
            ...body,
            userId: req.user.id,
        });

        return sendResponse(res, 201, true, 'Workflow created successfully', result);
    } catch (error) {
        const statusCode = error.code === 'VALIDATION_ERROR' ? 400 : 500;

        return sendResponse(res, statusCode, false, error.message, null, {
            code: error.code || 'WORKFLOW_CREATE_ERROR',
        });
    }
};

const list = async (req, res) => {
    try {
        const workflows = await workflowService.list(req.user.id);

        return sendResponse(res, 200, true, 'Workflows retrieved successfully', workflows);
    } catch (error) {
        return sendResponse(res, 500, false, 'Failed to retrieve workflows', null, {
            code: 'WORKFLOW_LIST_ERROR',
        });
    }
};

const runWorkflow = async (req, res) => {
    try {
        const body = req.body || {};
        const result = await workflowService.runWorkflow({
            runId: req.params.runId,
            workflowId: body.workflowId,
            goalPrompt: body.goalPrompt,
            userId: req.user.id,
            io: req.app.get('io'),
        });

        const statusCode = result.executionStarted ? 202 : 201;
        const messageByStatus = {
            AWAITING_APPROVAL: 'Workflow run is waiting for approval',
            COMPLETED: 'Workflow run completed successfully',
            FAILED: 'Workflow run failed',
        };
        const message = messageByStatus[result.status]
            || (result.executionStarted ? 'Workflow run started successfully' : 'Workflow plan created successfully');

        return sendResponse(res, statusCode, true, message, result);
    } catch (error) {
        const statusCodeMap = {
            VALIDATION_ERROR: 400,
            WORKFLOW_NOT_FOUND: 404,
            RUN_NOT_FOUND: 404,
            INVALID_RUN_STATUS: 409,
            RUN_ALREADY_PLANNED: 409,
            LLM_UNAVAILABLE: 503,
            PLANNER_ERROR: 502,
        };
        const statusCode = statusCodeMap[error.code] || 500;

        return sendResponse(res, statusCode, false, error.message, null, {
            code: error.code || 'WORKFLOW_RUN_ERROR',
        });
    }
};

const listRuns = async (req, res) => {
    try {
        const runs = await workflowService.listRuns(req.user.id);

        return sendResponse(res, 200, true, 'Workflow runs retrieved successfully', runs);
    } catch (error) {
        return sendResponse(res, 500, false, 'Failed to retrieve workflow runs', null, {
            code: 'RUN_LIST_ERROR',
        });
    }
};

const getWorkflowRun = async (req, res) => {
    try {
        const run = await workflowService.getWorkflowRun(req.params.runId, req.user.id);

        return sendResponse(res, 200, true, 'Workflow run retrieved successfully', run);
    } catch (error) {
        const statusCode = error.code === 'RUN_NOT_FOUND' ? 404 : 500;

        return sendResponse(res, statusCode, false, error.message, null, {
            code: error.code || 'RUN_DETAILS_ERROR',
        });
    }
};

module.exports = {
    create,
    list,
    runWorkflow,
    listRuns,
    getWorkflowRun,
};
