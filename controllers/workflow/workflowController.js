'use strict';
const workflowService = require('../../services/workflow/workflowService');
const sendResponse = require('../../utils/responseHelper');
const logger = require('../../utils/logger');
const {emitWorkflowEvent} = require('../../core/telemetry');

const create = async (req, res, next) => {
    try {
        const body = req.body || {};
        const result = await workflowService.create({
            ...body,
            userId: req.user.id,
        });

        return sendResponse(res, 201, true, 'Workflow created successfully', result);
    } catch (error) {
        return next(error);
    }
};

const list = async (req, res, next) => {
    try {
        const workflows = await workflowService.list(req.user.id);

        return sendResponse(res, 200, true, 'Workflows retrieved successfully', workflows);
    } catch (error) {
        return next(error);
    }
};

const runWorkflow = async (req, res, next) => {
    if (req.query.stream === 'true' || req.headers.accept === 'text/event-stream') {
        return runWorkflowStream(req, res);
    }

    try {
        const body = req.body || {};
        const result = await workflowService.runWorkflow({
            runId: req.params.runId,
            workflowId: body.workflowId,
            goalPrompt: body.goalPrompt,
            localDestination: body.localDestination,
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
        return next(error);
    }
};

/**
 * Live Real-Time Workflow Planning and Execution Stream using Server-Sent Events (SSE).
 * SSE handlers manage their own error responses since headers are already sent.
 */
const runWorkflowStream = async (req, res) => {
    const body = req.body || {};

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const sendEvent = (event, data) => {
        res.write(`data: ${JSON.stringify({ event, data, timestamp: new Date().toISOString() })}\n\n`);
    };

    sendEvent('status', { message: 'Initiating AI workflow planner...', phase: 'PLANNING' });

    try {
        const io = req.app.get('io');
        const streamIo = {
            to: (room) => ({
                emit: (event, payload) => {
                    io?.to(room).emit(event, payload);
                    sendEvent(event, payload);
                },
            }),
            emit: (event, payload) => {
                io?.emit(event, payload);
                sendEvent(event, payload);
            },
        };

        const result = await workflowService.runWorkflow({
            runId: req.params.runId,
            workflowId: body.workflowId,
            goalPrompt: body.goalPrompt,
            localDestination: body.localDestination,
            userId: req.user.id,
            io: streamIo,
        });

        sendEvent('plan_created', {
            runId: result.runId,
            status: result.status,
            phase: result.phase,
            tasksCreated: result.tasksCreated,
            plan: result.plan,
        });

        sendEvent('done', {
            success: true,
            runId: result.runId,
            message: 'Workflow plan created and running in background',
        });

        res.end();
    } catch (error) {
        logger.error('Workflow stream error', error);
        sendEvent('error', {
            success: false,
            code: error.code || 'WORKFLOW_RUN_ERROR',
            message: error.message || 'Workflow execution error',
        });
        res.end();
    }
};

const listRuns = async (req, res, next) => {
    try {
        const runs = await workflowService.listRuns(req.user.id);

        return sendResponse(res, 200, true, 'Workflow runs retrieved successfully', runs);
    } catch (error) {
        return next(error);
    }
};

const getWorkflowRun = async (req, res, next) => {
    try {
        const run = await workflowService.getWorkflowRun(req.params.runId, req.user.id);

        return sendResponse(res, 200, true, 'Workflow run retrieved successfully', run);
    } catch (error) {
        return next(error);
    }
};

const cancelWorkflow = async (req, res, next) => {
    try {
        const result = await workflowService.cancelRun({
            runId: req.params.runId,
            userId: req.user.id,
            reason: 'Workflow cancelled by user',
        });
        const io = req.app.get('io');

        if (io && result.updated) {
            emitWorkflowEvent({
                io,
                runId: result.runId,
                event: 'run_finished',
                source: 'SYSTEM',
                payload: {
                    runId: result.runId,
                    status: 'CANCELLED',
                    reason: 'Workflow cancelled by user',
                    completedAt: result.run.completed_at,
                },
            });
        }

        return sendResponse(res, 200, true, result.updated
            ? 'Workflow cancelled successfully'
            : `Workflow is already ${String(result.status).toLowerCase()}`,
        result);
    } catch (error) {
        return next(error);
    }
};

module.exports = {
    create,
    list,
    runWorkflow,
    runWorkflowStream,
    listRuns,
    getWorkflowRun,
    cancelWorkflow,
};
