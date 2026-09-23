const crypto = require('crypto');

const {generateStructureClient} = require('../configs/llm');
const {
    bulkInsertTaskNodes,
    updateExecutionRunStatus,
} = require('../models/workflow/workflowModel');
const {dagPlanSchema} = require('../validators/workflow/workflowValidator');

const validatePlan = (plan) => {
    const schemaResult = dagPlanSchema.validate(plan, {
        abortEarly: false,
        allowUnknown: false,
        convert: true,
    });

    if (schemaResult.error) {
        return {
            success: false,
            error: {
                message: schemaResult.error.details
                    .map((detail) => detail.message.replace(/"/g, ''))
                    .join(', '),
            },
        };
    }

    plan = schemaResult.value;

    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
        return {
            success: false,
            error: {
                message: 'The plan must be an object',
            },
        };
    }

    if (typeof plan.workflowTitle !== 'string' || !plan.workflowTitle.trim()) {
        return {
            success: false,
            error: {
                message: 'workflowTitle is required',
            },
        };
    }

    if (typeof plan.summary !== 'string') {
        return {
            success: false,
            error: {
                message: 'summary must be a string',
            },
        };
    }

    if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
        return {
            success: false,
            error: {
                message: 'tasks must be a non-empty array',
            },
        };
    }

    for (const task of plan.tasks) {
        if (!task || typeof task !== 'object') {
            return {
                success: false,
                error: {
                    message: 'Each task must be an object',
                },
            };
        }

        const requiredStringFields = [
            'nodeKey',
            'title',
            'instruction',
            'assignedTool',
        ];

        for (const field of requiredStringFields) {
            if (typeof task[field] !== 'string' || !task[field].trim()) {
                return {
                    success: false,
                    error: {
                        message: `Each task must include a non-empty ${field}`,
                    },
                };
            }
        }

        if (!Array.isArray(task.dependencies)) {
            return {
                success: false,
                error: {
                    message: `Task ${task.nodeKey} dependencies must be an array`,
                },
            };
        }

        if (task.toolInput !== undefined && (
            task.toolInput === null ||
            typeof task.toolInput !== 'object' ||
            Array.isArray(task.toolInput)
        )) {
            return {
                success: false,
                error: {
                    message: `Task ${task.nodeKey} toolInput must be an object`,
                },
            };
        }
    }

    return {
        success: true,
        data: plan,
    };
};

/**
 * Check for circular dependencies in a DAG using Kahn's algorithm.
 */
const validateAcyclicGraph = (tasks) => {
    const inDegree = new Map();
    const adjacencyList = new Map();

    for (const task of tasks) {
        if (inDegree.has(task.nodeKey)) {
            return false;
        }

        inDegree.set(task.nodeKey, 0);
        adjacencyList.set(task.nodeKey, []);
    }

    for (const task of tasks) {
        for (const dependency of task.dependencies) {
            if (!adjacencyList.has(dependency)) {
                return false;
            }

            adjacencyList.get(dependency).push(task.nodeKey);
            inDegree.set(task.nodeKey, inDegree.get(task.nodeKey) + 1);
        }
    }

    const queue = [];

    for (const [nodeKey, degree] of inDegree) {
        if (degree === 0) {
            queue.push(nodeKey);
        }
    }

    let visitedCount = 0;

    while (queue.length > 0) {
        const currentNode = queue.shift();
        visitedCount++;

        for (const neighbor of adjacencyList.get(currentNode)) {
            const nextDegree = inDegree.get(neighbor) - 1;
            inDegree.set(neighbor, nextDegree);

            if (nextDegree === 0) {
                queue.push(neighbor);
            }
        }
    }

    return visitedCount === tasks.length;
};

const planWorkflowRun = async ({
    runId,
    goalPrompt,
    userId,
    io = null,
    scheduler = null,
}) => {
    console.log(`\n🧠 [Planner 1.0] Starting Goal Decomposition for Run: ${runId}`);

    const systemPrompt = `
You are OmniAgent, an autonomous AI workflow planner.
Decompose the user goal into a Directed Acyclic Graph (DAG) of executable subtasks.
Available Tools:
1. 'executeCommand' - Run shell commands, tests, or scripts (in sandboxed workspace).
2. 'fileManager' - Create, edit, read, or patch files.
3. 'webSearch' - Query Google/DuckDuckGo and extract markdown from URLs.
4. 'databaseConnector' - Execute SQL queries on the database.
5. 'httpRequester' - Make REST API calls (GET, POST, PUT, DELETE).

Rules:
- Assign dependencies logically (for example, task_2 depends on ['task_1']).
- Never create circular dependencies.
- Every dependency must reference an existing nodeKey.
- Output must strictly follow this JSON structure:
{
  "workflowTitle": "string",
  "summary": "string",
  "tasks": [
    {
      "nodeKey": "string",
      "title": "string",
      "instruction": "string",
      "dependencies": ["string"],
      "assignedTool": "string",
      "toolInput": {}
    }
  ]
}`;

    let attempts = 0;
    const maxAttempts = 3;
    let currentPrompt = `Goal:\n"${goalPrompt}"`;
    let validatedPlan = null;
    let lastPlannerError = null;

    while (attempts < maxAttempts) {
        attempts++;

        try {
            console.log(`📡 [Planner] Invoking LLM Planner (Attempt ${attempts}/${maxAttempts})...`);

            const rawResult = await generateStructureClient({
                systemPrompt,
                userPrompt: currentPrompt,
            });

            const parsed = validatePlan(rawResult.data);

            if (!parsed.success) {
                lastPlannerError = new Error(parsed.error.message);
                console.warn('⚠️ [Planner] Plan validation failed:', parsed.error.message);
                currentPrompt = `Previous output had validation errors: ${parsed.error.message}. Generate a corrected plan for this goal:\n${goalPrompt}`;
                continue;
            }

            if (!validateAcyclicGraph(parsed.data.tasks)) {
                lastPlannerError = new Error('The generated plan contains an invalid dependency graph');
                console.warn('⚠️ [Planner] Invalid dependency graph. Re-planning...');
                currentPrompt = `The task dependencies contain a missing dependency or circular dependency. Generate a valid acyclic plan for this goal:\n${goalPrompt}`;
                continue;
            }

            validatedPlan = parsed.data;
            break;
        } catch (error) {
            lastPlannerError = error;
            console.error(`❌ [Planner Attempt Error]:`, error.message);
            currentPrompt = `An error occurred: ${error.message}. Generate valid DAG JSON for this goal:\n${goalPrompt}`;
        }
    }

    if (!validatedPlan) {
        await updateExecutionRunStatus(runId, 'FAILED');

        const error = new Error('Failed to generate a valid acyclic DAG plan after maximum attempts.');
        error.code = [500, 502, 503, 504].includes(Number(lastPlannerError?.code))
            ? 'LLM_UNAVAILABLE'
            : 'PLANNER_ERROR';
        error.cause = lastPlannerError;
        throw error;
    }

    const taskNodeRecords = validatedPlan.tasks.map((task) => ({
        id: crypto.randomUUID(),
        runId,
        nodeKey: task.nodeKey,
        title: task.title,
        instruction: task.instruction,
        dependencies: task.dependencies,
        assignedTool: task.assignedTool,
        toolInput: task.toolInput || {},
        status: 'PENDING',
        retryCount: 0,
    }));

    await bulkInsertTaskNodes(taskNodeRecords);

    const executionStarted = typeof scheduler === 'function';
    let execution = null;

    if (executionStarted) {
        await updateExecutionRunStatus(runId, 'RUNNING');
    }

    if (io) {
        io.to(`run_${runId}`).emit('run_started', {
            runId,
            title: validatedPlan.workflowTitle,
            summary: validatedPlan.summary,
            tasks: validatedPlan.tasks,
        });
    }

    if (executionStarted) {
        execution = await scheduler(runId);
    }

    const executionStatus = execution?.status === 'WAITING_APPROVAL'
        ? 'AWAITING_APPROVAL'
        : execution?.status;

    console.log(
        `✅ [Planner 1.0 Complete] Plan created for Run: ${runId}. ` +
        `Execution started: ${executionStarted}`,
    );

    return {
        success: true,
        runId,
        userId,
        status: executionStatus || (executionStarted ? 'RUNNING' : 'PENDING'),
        phase: executionStarted ? 'EXECUTION' : 'PLANNED',
        executionStarted,
        tasksCreated: taskNodeRecords.length,
        plan: validatedPlan,
        execution,
    };
};

module.exports = {
    validateAcyclicGraph,
    planWorkflowRun,
};
