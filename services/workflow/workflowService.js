const workflowModel = require('../../models/workflow/workflowModel');
const { v4: uuidv4 } = require('uuid');
const { planWorkflowRun } = require('../../core/planner');
const { triggerScheduler, cancelActiveRun } = require('../../core/scheduler');
const { executeTaskNode } = require('../../core/executor');

const startScheduler = (runId, io = null) => triggerScheduler(runId, {
    io,
    executor: executeTaskNode,
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
                startScheduler(runId, io).catch((error) => {
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

    const resolvedLocalDestination = localDestination
        || (projectContext?.workspacePath)
        || (projectContext?.name ? `Desktop/${projectContext.name}` : '')
        || (typeof projectContext === 'string' ? `Desktop/${projectContext}` : '');

    const planningPromise = planWorkflowRun({
        runId: executionRun.id,
        goalPrompt: executionRun.goal_prompt,
        images,
        localDestination: resolvedLocalDestination,
        userId,
        io,
        isAborted,
    });

    const abortWatcher = waitForClientAbort(isAborted);
    let plan;
    try {
        const result = abortWatcher.promise
            ? await Promise.race([
                planningPromise.then((value) => ({type: 'planned', value})),
                abortWatcher.promise.then(() => ({type: 'aborted'})),
            ])
            : {type: 'planned', value: await planningPromise};

        if (result.type === 'aborted') {
            // The planner may still be waiting for an upstream model timeout.
            // It receives isAborted and will stop before persisting tasks; keep
            // its eventual rejection from becoming an unhandled promise.
            planningPromise.catch(() => {});
            await workflowModel.cancelExecutionRun(
                executionRun.id,
                userId,
                'Client aborted workflow planning',
            );
            return cancelledPlanningResult(executionRun.id, userId);
        }

        plan = result.value;
    } catch (error) {
        if (typeof isAborted === 'function' && isAborted()) {
            await workflowModel.cancelExecutionRun(
                executionRun.id,
                userId,
                'Client aborted workflow planning',
            ).catch(() => {});
            return cancelledPlanningResult(executionRun.id, userId);
        }
        throw error;
    } finally {
        abortWatcher.cleanup();
    }

    if (typeof isAborted === 'function' && isAborted()) {
        console.log(`🛑 [Workflow Service] Run ${executionRun.id} was aborted before scheduler started.`);
        await workflowModel.cancelExecutionRun(executionRun.id, userId, 'Client aborted workflow planning');
        return {
            ...plan,
            ...cancelledPlanningResult(executionRun.id, userId),
        };
    }

    setImmediate(async () => {
        try {
            const currentRun = await workflowModel.getExecutionById(executionRun.id, userId);
            if (currentRun?.status === 'CANCELLED') {
                console.log(`🛑 [Workflow Service] Run ${executionRun.id} is CANCELLED. Skipping scheduler.`);
                return;
            }
            startScheduler(executionRun.id, io).catch((error) => {
                console.error(`❌ [Workflow Execution Error] ${executionRun.id}:`, error.message);
            });
        } catch (checkErr) {
            console.error(`❌ [Workflow Pre-Scheduler Error] ${executionRun.id}:`, checkErr.message);
        }
    });

    return {
        ...plan,
        runId: executionRun.id,
        status: 'RUNNING',
        phase: 'EXECUTION',
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

    const tasks = await workflowModel.listLatestTaskNodesByRunId(runId);
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
