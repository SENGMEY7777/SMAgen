const workflowModel = require('../../models/workflow/workflowModel');
const { v4: uuidv4 } = require('uuid');
const { planWorkflowRun } = require('../../core/planner');

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

const runWorkflow = async ({runId, workflowId, goalPrompt, userId}) => {
    let executionRun;

    if (runId) {
        executionRun = await workflowModel.getExecutionById(runId, userId);

        if (!executionRun) {
            const error = new Error('Workflow run not found');
            error.code = 'RUN_NOT_FOUND';
            throw error;
        }

        if (executionRun.status !== 'PENDING') {
            const error = new Error(`Workflow run cannot be started from ${executionRun.status} status`);
            error.code = 'INVALID_RUN_STATUS';
            throw error;
        }
    } else {
        if (!workflowId || !goalPrompt) {
            const error = new Error('workflowId and goalPrompt are required');
            error.code = 'VALIDATION_ERROR';
            throw error;
        }

        const workflow = await workflowModel.getWorkflowById(workflowId, userId);

        if (!workflow) {
            const error = new Error('Workflow not found');
            error.code = 'WORKFLOW_NOT_FOUND';
            throw error;
        }

        executionRun = await workflowModel.createExecutionRun({
            id: uuidv4(),
            workflowId,
            userId,
            goalPrompt,
        });
    }

    return planWorkflowRun({
        runId: executionRun.id,
        goalPrompt: executionRun.goal_prompt,
        userId,
    });
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

    const tasks = await workflowModel.listTaskNodesByRunId(runId);

    return {
        ...executionRun,
        tasks,
    };
}

module.exports = {
    create,
    list,
    runWorkflow,
    listRuns,
    getWorkflowRun,
}
