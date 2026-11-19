const workflowModel = require('../../models/workflow/workflowModel');
const { v4: uuidv4 } = require('uuid');
const { planWorkflowRun } = require('../../core/planner');
const { triggerScheduler, cancelActiveRun } = require('../../core/scheduler');
const { executeTaskNode } = require('../../core/executor');
const { emitWorkflowEvent } = require('../../core/telemetry');

const activePlanningRuns = new Map();

const startScheduler = (runId, io = null, options = {}) => triggerScheduler(runId, {
    io,
    executor: executeTaskNode,
    ...options,
});

const waitForClientAbort = (isAborted) => {
    if (typeof isAborted !== 'function') {
        return {promise: null, cleanup: () => {}};
    }

    let interval = null;
    let settled = false;
    let resolveAbort;
    const promise = new Promise((resolve) => {
        resolveAbort = resolve;
        const check = () => {
            if (!settled && isAborted()) {
                settled = true;
                if (interval) clearInterval(interval);
                resolve(true);
            }
        };

        check();
        if (!settled) interval = setInterval(check, 100);
    });

    return {
        promise,
        cleanup: () => {
            settled = true;
            if (interval) clearInterval(interval);
            resolveAbort?.(false);
        },
    };
};

const cancelledPlanningResult = (runId, userId) => ({
    success: true,
    runId,
    userId,
    status: 'CANCELLED',
    phase: 'CANCELLED',
    executionStarted: false,
    tasksCreated: 0,
    plan: null,
    execution: null,
});

const cancelPlanningRun = (runId) => {
    const controller = activePlanningRuns.get(String(runId));
    if (!controller) return false;
    controller.abort();
    return true;
};

const startPlanningInBackground = ({
    executionRun,
    images,
    localDestination,
    userId,
    io,
    isAborted,
}) => {
    const runKey = String(executionRun.id);
    const planningController = new AbortController();
    activePlanningRuns.set(runKey, planningController);

    const planningIsAborted = () => (
        planningController.signal.aborted
        || (typeof isAborted === 'function' && isAborted())
    );

    setImmediate(async () => {
        try {
            await planWorkflowRun({
                runId: executionRun.id,
                goalPrompt: executionRun.goal_prompt,
                images,
                localDestination,
                userId,
                io,
                isAborted: planningIsAborted,
            });

            const currentRun = await workflowModel.getExecutionById(executionRun.id, userId);
            if (!currentRun || currentRun.status === 'CANCELLED') {
                console.log(`🛑 [Workflow Service] Run ${executionRun.id} was cancelled before scheduler started.`);
                return;
            }

            startScheduler(executionRun.id, io).catch((error) => {
                console.error(`❌ [Workflow Execution Error] ${executionRun.id}:`, error.message);
            });
        } catch (error) {
            const currentRun = await workflowModel.getExecutionById(executionRun.id, userId).catch(() => null);
            if (!currentRun || currentRun.status === 'CANCELLED') return;

            await workflowModel.updateExecutionRunStatus(executionRun.id, 'FAILED').catch(() => {});
            await workflowModel.createExecutionLog({
                id: uuidv4(),
                runId: executionRun.id,
                level: 'ERROR',
                source: 'PLANNER',
                message: JSON.stringify({
                    event: 'planning_failed',
                    code: error.code || 'PLANNER_ERROR',
                    message: error.message || 'Workflow planning failed',
                }),
            }).catch(() => {});

            emitWorkflowEvent({
                io,
                runId: executionRun.id,
                event: 'run_finished',
                source: 'PLANNER',
                payload: {
                    runId: executionRun.id,
                    status: 'FAILED',
                    error: error.message || 'Workflow planning failed',
                    completedAt: new Date(),
                },
            });
        } finally {
            activePlanningRuns.delete(runKey);
        }
    });
};

const create = async ({title, description, systemPrompt, userId}) => {
    if (!title || !systemPrompt || !userId) {
        const error = new Error('Title, system prompt, and user ID are required');
        error.code = 'VALIDATION_ERROR';
        throw error;
    }

    const workflowId = uuidv4();
    const workflow = await workflowModel.create({
        id: workflowId,
        title,
        description,
        systemPrompt,
        userId,
    });

    return workflow;
}

const list = async (userId) => {
    return workflowModel.listWorkflowsByUser(userId);
}

const runWorkflow = async ({runId, workflowId, goalPrompt, images = [], projectContext, localDestination, userId, io = null, isAborted = null}) => {
    let executionRun;

    if (runId) {
        executionRun = await workflowModel.getExecutionById(runId, userId);

        if (!executionRun) {
            const error = new Error('Workflow run not found');
            error.code = 'RUN_NOT_FOUND';
            throw error;
        }

        if (!['PENDING', 'AWAITING_APPROVAL'].includes(executionRun.status)) {
            const error = new Error(`Workflow run cannot be started from ${executionRun.status} status`);
            error.code = 'INVALID_RUN_STATUS';
            throw error;
        }

        const existingTasks = await workflowModel.listTaskNodesByRunId(runId);

        if (existingTasks.length > 0) {
            setImmediate(() => {
                startScheduler(runId, io, {resumeAfterActive: true}).catch((error) => {
                    console.error(`❌ [Workflow Resume Error] ${runId}:`, error.message);
                });
            });

            return {
                success: true,
                runId,
                userId,
                status: 'RUNNING',
                phase: 'EXECUTION',
                executionStarted: true,
                tasksCreated: existingTasks.length,
                execution: null,
            };
        }
    } else {
        if (typeof goalPrompt !== 'string' || !goalPrompt.trim()) {
            goalPrompt = 'Review project and execute requested workflow tasks';
        }

        if (workflowId) {
            const workflow = await workflowModel.getWorkflowById(workflowId, userId);

            if (!workflow) {
                const error = new Error('Workflow not found');
                error.code = 'WORKFLOW_NOT_FOUND';
                throw error;
            }
        } else {
            workflowId = uuidv4();

            await workflowModel.create({
                id: workflowId,
                title: goalPrompt.trim().slice(0, 255),
                description: 'Automatically created for this workflow run',
                systemPrompt: 'You are SMAgen. Execute the user goal as a safe, structured workflow.',
                userId,
            });
        }

        executionRun = await workflowModel.createExecutionRun({
            id: uuidv4(),
            workflowId,
            userId,
            goalPrompt: goalPrompt.trim(),
        });
    }

    const hasRemoteProjectUrl = /https?:\/\/[^\s]+/i.test(String(executionRun.goal_prompt || goalPrompt || ''));
    const resolvedLocalDestination = localDestination
        || (hasRemoteProjectUrl
            ? ''
            : projectContext?.workspacePath
                || (projectContext?.name ? `Desktop/${projectContext.name}` : '')
                || (typeof projectContext === 'string' ? `Desktop/${projectContext}` : ''));

    startPlanningInBackground({
        executionRun,
        images,
        localDestination: resolvedLocalDestination,
        userId,
        io,
        isAborted,
    });

    return {
        success: true,
        runId: executionRun.id,
        status: 'PLANNING',
        phase: 'PLANNING',
        executionStarted: true,
        execution: null,
    };
}

const listRuns = async (userId) => {
    return workflowModel.listExecutionRunsByUser(userId);
}

const getWorkflowRun = async (runId, userId) => {
    const executionRun = await workflowModel.getExecutionById(runId, userId);

    if (!executionRun) {
        const error = new Error('Workflow run not found');
        error.code = 'RUN_NOT_FOUND';
        throw error;
    }

    // A completed run can contain multiple task batches (for example, the
    // original plan plus self-healing or verification tasks). Returning only
    // the latest batch hides earlier file-manager tasks from the client, so
    // the workflow review cannot list or display every updated file.
    const tasks = await workflowModel.listTaskNodesByRunId(runId);
    const logs = await workflowModel.listExecutionLogsByRunId(runId);

    return {
        ...executionRun,
        tasks,
        logs,
    };
}

const cancelRun = async ({runId, userId, reason = 'Workflow cancelled by user'}) => {
    const result = await workflowModel.cancelExecutionRun(runId, userId, reason);

    if (!result.run) {
        const error = new Error('Workflow run not found');
        error.code = 'RUN_NOT_FOUND';
        throw error;
    }

    if (result.updated) {
        cancelPlanningRun(runId);
        cancelActiveRun(runId);
    }

    return {
        runId,
        status: result.run.status,
        updated: result.updated,
        run: result.run,
    };
};

const deleteRun = async (runId, userId) => {
    cancelActiveRun(runId);
    const deleted = await workflowModel.deleteExecutionRunById(runId, userId);
    if (!deleted) {
        const error = new Error('Workflow run not found');
        error.code = 'RUN_NOT_FOUND';
        throw error;
    }
    return { success: true, id: runId };
};

module.exports = {
    create,
    list,
    runWorkflow,
    listRuns,
    getWorkflowRun,
    cancelRun,
    deleteRun,
};
