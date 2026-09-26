const workflowModel = require('../../models/workflow/workflowModel');
const { v4: uuidv4 } = require('uuid');
const { planWorkflowRun } = require('../../core/planner');
const { triggerScheduler } = require('../../core/scheduler');
const { executeTaskNode } = require('../../core/executor');

const startScheduler = (runId, io = null) => triggerScheduler(runId, {
    io,
    executor: executeTaskNode,
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

const runWorkflow = async ({runId, workflowId, goalPrompt, userId, io = null}) => {
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
            const error = new Error('goalPrompt is required');
            error.code = 'VALIDATION_ERROR';
            throw error;
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

    const plan = await planWorkflowRun({
        runId: executionRun.id,
        goalPrompt: executionRun.goal_prompt,
        userId,
        io,
    });

    setImmediate(() => {
        startScheduler(executionRun.id, io).catch((error) => {
            console.error(`❌ [Workflow Execution Error] ${executionRun.id}:`, error.message);
        });
    });

    return {
        ...plan,
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

module.exports = {
    create,
    list,
    runWorkflow,
    listRuns,
    getWorkflowRun,
}
