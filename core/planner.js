const crypto = require('crypto');

const {generateStructureClient} = require('../configs/llm');
const {
    bulkInsertTaskNodes,
    updateExecutionRunStatus,
} = require('../models/workflow/workflowModel');
const {dagPlanSchema} = require('../validators/workflow/workflowValidator');
const {emitWorkflowEvent} = require('./telemetry');

const TOOL_MAP = {
    executecommand: 'executeCommand',
    execute_command: 'executeCommand',
    command: 'executeCommand',
    bash: 'executeCommand',
    shell: 'executeCommand',
    filemanager: 'fileManager',
    file_manager: 'fileManager',
    file: 'fileManager',
    websearch: 'webSearch',
    web_search: 'webSearch',
    search: 'webSearch',
    databaseconnector: 'databaseConnector',
    database_connector: 'databaseConnector',
    sql: 'databaseConnector',
    httprequester: 'httpRequester',
    http_requester: 'httpRequester',
    http: 'httpRequester',
    api: 'httpRequester',
    imagegenerator: 'imageGenerator',
    image_generator: 'imageGenerator',
    image: 'imageGenerator',
};

const LOCAL_DESKTOP_OUTPUT_ENABLED = String(process.env.NODE_ENV || 'development').trim().toLowerCase() !== 'production'
    && String(process.env.LOCAL_DESKTOP_OUTPUT || '').trim().toLowerCase() === 'true';

const DIRECTORY_ACTIONS = new Set([
    'mkdir',
    'createdirectory',
    'create_directory',
    'createdesktopdirectory',
    'create_desktop_directory',
]);

const DESKTOP_FILE_ACTION = 'createDesktopFile';
const FILE_WRITE_ACTIONS = new Set(['create', 'write', 'update', 'append']);

const cleanRelativeDirectoryPath = (value) => {
    if (typeof value !== 'string') {
        return null;
    }

    const cleaned = value
        .trim()
        .replace(/^['"`]|['"`]$/g, '')
        .replace(/^desktop[\\/]+/i, '');

    if (
        !cleaned
        || cleaned.startsWith('~')
        || cleaned.startsWith('/')
        || /^[A-Za-z]:[\\/]/.test(cleaned)
        || cleaned.split(/[\\/]/).includes('..')
    ) {
        return null;
    }

    return cleaned;
};

const inferDirectoryPath = (task, toolInput, goalPrompt = '') => {
    const directPath = cleanRelativeDirectoryPath(toolInput.path);

    if (directPath) {
        return directPath;
    }

    const command = String(toolInput.command || '').trim();
    const mkdirMatch = command.match(/^mkdir(?:\s+(?:-p|--parents))?\s+(.+)$/i);

    if (mkdirMatch) {
        const commandArguments = mkdirMatch[1].match(/"[^"]*"|'[^']*'|\S+/g) || [];

        for (let index = commandArguments.length - 1; index >= 0; index -= 1) {
            const commandPath = cleanRelativeDirectoryPath(commandArguments[index]);

            if (commandPath) {
                return commandPath;
            }
        }
    }

    const taskText = `${goalPrompt} ${task.title || ''} ${task.instruction || ''}`;
    const quotedName = taskText.match(
        /\b(?:directory|folder)\b[\s\S]{0,80}\b(?:named|called|name)\b\s+["']([^"']+)["']/i,
    );

    if (quotedName) {
        return cleanRelativeDirectoryPath(quotedName[1]);
    }

    const plainName = taskText.match(
        /\b(?:directory|folder)\b[\s\S]{0,80}\b(?:named|called|name)\b\s+([A-Za-z0-9_-]+)(?=\s+(?:on|in|inside|with|and)\b|[.,;!?]|$)/i,
    );

    return cleanRelativeDirectoryPath(plainName?.[1]);
};

const isDirectoryCreationTask = (task, toolInput) => {
    const action = String(toolInput.action || '').trim().toLowerCase();
    const command = String(toolInput.command || '').trim();
    const taskText = `${task.title || ''} ${task.instruction || ''}`;

    return DIRECTORY_ACTIONS.has(action)
        || /^mkdir(?:\s|$)/i.test(command)
        || /\b(?:create|make|add)\s+(?:a\s+)?(?:new\s+)?(?:directory|folder)\b/i.test(taskText)
        || /\b(?:directory|folder)\s+(?:named|called)\b/i.test(taskText);
};

const normalizeDirectoryTask = (task, goalPrompt) => {
    const toolInput = task.toolInput || {};

    if (!isDirectoryCreationTask(task, toolInput)) {
        return task;
    }

    const directoryPath = inferDirectoryPath(task, toolInput, goalPrompt);

    if (!directoryPath) {
        return task;
    }

    const targetText = `${goalPrompt || ''} ${task.title || ''} ${task.instruction || ''} ${toolInput.path || ''}`;
    const targetsDesktop = LOCAL_DESKTOP_OUTPUT_ENABLED && /\bdesktop\b/i.test(targetText);

    return {
        ...task,
        assignedTool: 'fileManager',
        toolInput: {
            action: targetsDesktop ? 'createDesktopDirectory' : 'createDirectory',
            path: directoryPath,
        },
    };
};

const cleanRelativeFilePath = (value) => {
    if (typeof value !== 'string') {
        return null;
    }

    const cleaned = value
        .trim()
        .replace(/^['"`]|['"`]$/g, '')
        .replace(/^desktop[\\/]+/i, '');

    if (
        !cleaned
        || cleaned.startsWith('~')
        || cleaned.startsWith('/')
        || /^[A-Za-z]:[\\/]/.test(cleaned)
        || cleaned.split(/[\\/]/).includes('..')
    ) {
        return null;
    }

    return cleaned.replace(/\\/g, '/');
};

const isDesktopDirectoryTask = (task) => {
    const action = String(task.toolInput?.action || '').trim().toLowerCase();
    return action === 'createdesktopdirectory' || action === 'create_desktop_directory';
};

const normalizeDesktopFileTasks = (tasks, goalPrompt) => {
    const desktopDirectoryTasks = tasks.filter(isDesktopDirectoryTask);
    const desktopGoal = LOCAL_DESKTOP_OUTPUT_ENABLED && /\bdesktop\b/i.test(String(goalPrompt || ''));

    if (!desktopDirectoryTasks.length && !desktopGoal) {
        return tasks;
    }

    const inferredDirectoryPath = desktopDirectoryTasks[0]?.toolInput?.path
        || inferDirectoryPath({title: '', instruction: ''}, {}, goalPrompt);

    return tasks.map((task) => {
        if (task.assignedTool !== 'fileManager') {
            return task;
        }

        const action = String(task.toolInput?.action || '').trim().toLowerCase();
        if (!FILE_WRITE_ACTIONS.has(action)) {
            return task;
        }

        const dependsOnDesktopDirectory = task.dependencies.some((dependency) => {
            return desktopDirectoryTasks.some((directoryTask) => directoryTask.nodeKey === dependency);
        });

        if (!dependsOnDesktopDirectory && !desktopGoal) {
            return task;
        }

        const filePath = cleanRelativeFilePath(task.toolInput.path);
        if (!filePath) {
            return task;
        }

        const directoryPath = cleanRelativeDirectoryPath(inferredDirectoryPath);
        const desktopPath = directoryPath
            && filePath !== directoryPath
            && !filePath.startsWith(`${directoryPath}/`)
            ? `${directoryPath}/${filePath}`
            : filePath;

        return {
            ...task,
            toolInput: {
                ...task.toolInput,
                action: DESKTOP_FILE_ACTION,
                path: desktopPath,
            },
        };
    });
};

const normalizePlan = (rawPlan, {goalPrompt = ''} = {}) => {
    if (!rawPlan || typeof rawPlan !== 'object') return rawPlan;

    const plan = { ...rawPlan };
    plan.workflowTitle = String(plan.workflowTitle || plan.title || 'Workflow Plan').trim();
    plan.summary = String(plan.summary || plan.description || 'Execution plan generated by KAIRO').trim();

    if (Array.isArray(plan.tasks)) {
        const keyMap = new Map();

        // Pass 1: Normalize nodeKeys and assignedTool
        plan.tasks = plan.tasks.map((task, idx) => {
            const rawKey = String(task.nodeKey || task.id || `task_${idx + 1}`).trim();
            let cleanKey = rawKey.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+/, 'task_') || `task_${idx + 1}`;
            if (!/^[A-Za-z]/.test(cleanKey)) {
                cleanKey = `task_${cleanKey}`;
            }

            keyMap.set(rawKey, cleanKey);
            keyMap.set(String(idx + 1), cleanKey);
            keyMap.set(`task ${idx + 1}`, cleanKey);

            const rawTool = String(task.assignedTool || 'executeCommand').trim();
            const normalizedTool = TOOL_MAP[rawTool.toLowerCase()] || rawTool.replace(/[^A-Za-z0-9_-]/g, '_') || 'executeCommand';

            return normalizeDirectoryTask({
                nodeKey: cleanKey,
                title: String(task.title || `Task ${idx + 1}`).trim(),
                instruction: String(task.instruction || task.description || task.title || '').trim(),
                dependencies: Array.isArray(task.dependencies) ? task.dependencies : [],
                assignedTool: normalizedTool,
                toolInput: (task.toolInput && typeof task.toolInput === 'object' && !Array.isArray(task.toolInput)) ? task.toolInput : {},
            }, goalPrompt);
        });

        // Pass 2: Map and filter dependencies to ensure valid references only
        const existingKeys = new Set(plan.tasks.map((t) => t.nodeKey));
        plan.tasks.forEach((task) => {
            task.dependencies = task.dependencies
                .map((dep) => keyMap.get(String(dep).trim()) || String(dep).trim())
                .filter((dep) => existingKeys.has(dep) && dep !== task.nodeKey);
            task.dependencies = [...new Set(task.dependencies)];
        });

        // A Desktop directory task establishes the destination for dependent file writes.
        // Without this pass, the directory goes to ~/Desktop while its files stay in workspaces/<runId>.
        plan.tasks = normalizeDesktopFileTasks(plan.tasks, goalPrompt);
    }

    return plan;
};

const validatePlan = (rawPlan, options = {}) => {
    const normalized = normalizePlan(rawPlan, options);

    const schemaResult = dagPlanSchema.validate(normalized, {
        abortEarly: false,
        allowUnknown: true,
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

    const plan = schemaResult.value;

    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
        return {
            success: false,
            error: {
                message: 'The plan must be an object',
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

const planCache = new Map();
const MAX_CACHE_SIZE = 100;

const getCacheKey = (goalPrompt) => {
    return String(goalPrompt || '').trim().toLowerCase().replace(/\s+/g, ' ');
};

const planWorkflowRun = async ({
    runId,
    goalPrompt,
    userId,
    io = null,
    scheduler = null,
}) => {
    console.log(`\n🧠 [Planner 1.0] Starting Goal Decomposition for Run: ${runId}`);

    emitWorkflowEvent({
        io,
        runId,
        event: 'planning_started',
        source: 'PLANNER',
        payload: {
            runId,
            goalPrompt,
            status: 'PLANNING',
        },
    });

    const cacheKey = getCacheKey(goalPrompt);
    let validatedPlan = null;

    if (planCache.has(cacheKey)) {
        console.log(`⚡ [Planner Cache Hit] Reusing validated DAG plan for goal: "${goalPrompt}"`);
        const cached = planCache.get(cacheKey);
        validatedPlan = normalizePlan(JSON.parse(JSON.stringify(cached)), {goalPrompt});
    }

    if (!validatedPlan) {
        const desktopInstruction = LOCAL_DESKTOP_OUTPUT_ENABLED
            ? `- Local Desktop output is enabled for development. For a request to create a folder directly on the Mac Desktop, use fileManager with {"action":"createDesktopDirectory","path":"folder-name"}.`
            : '- Host Desktop output is disabled. Use fileManager action createDirectory with a relative path inside the workflow workspace; never target a host Desktop.';
        const systemPrompt = `
You are KAIRO, an autonomous AI workflow planner.
Decompose the user goal into a Directed Acyclic Graph (DAG) of executable subtasks.
Available Tools:
1. 'executeCommand' - Run allowlisted, read-only workspace commands such as cat, head, tail, grep, ls, pwd, find, and wc. Never use executeCommand or mkdir for directory creation; use fileManager instead.
2. 'fileManager' - Create, edit, read, list, delete files, create workspace directories, or create a local Desktop directory when explicitly enabled. Use {"action":"createDirectory","path":"relative/directory"} for workspace directories.
3. 'webSearch' - Query DuckDuckGo; set toolInput.scrape=true when page HTML should be converted to Markdown.
4. 'databaseConnector' - Execute parameterized SQL with toolInput.sql and toolInput.params.
5. 'httpRequester' - Make HTTP/HTTPS API calls with toolInput.method, url, headers, params, and data.
6. 'imageGenerator' - Generate images, UI mockups, banners, or logos with toolInput.prompt, toolInput.fileName, and toolInput.aspectRatio ('1:1', '16:9', '9:16', '4:3').

Rules:
- Assign dependencies logically (for example, task_2 depends on ['task_1']).
- Never create circular dependencies.
- Every dependency must reference an existing nodeKey.
- Never use an absolute path or a path containing '..'. The executor enforces either the workspace boundary or the explicitly enabled local Desktop boundary.
- For regular directory creation, prefer the fileManager tool with action 'createDirectory'.
- Never assign executeCommand to a directory or folder creation task.
${desktopInstruction}
- Output must strictly follow this JSON structure:
{
  "workflowTitle": "string",
  "summary": "string",
  "tasks": [
    {
      "nodeKey": "task_1",
      "title": "string",
      "instruction": "string",
      "dependencies": [],
      "assignedTool": "executeCommand",
      "toolInput": {}
    }
  ]
}`;

        let attempts = 0;
        const maxAttempts = 3;
        let currentPrompt = `Goal:\n"${goalPrompt}"`;
        let lastPlannerError = null;

        while (attempts < maxAttempts) {
            attempts++;

            try {
                console.log(`📡 [Planner] Invoking LLM Planner (Attempt ${attempts}/${maxAttempts})...`);

                const rawResult = await generateStructureClient({
                    systemPrompt,
                    userPrompt: currentPrompt,
                    runId,
                    io,
                });

                const parsed = validatePlan(rawResult.data, {goalPrompt});

                if (!parsed.success) {
                    lastPlannerError = new Error(parsed.error.message);
                    console.warn('⚠️ [Planner] Plan validation failed:', parsed.error.message);
                    currentPrompt = `Previous output had validation errors: ${parsed.error.message}. Generate a corrected plan for this goal:\n${goalPrompt}`;
                    continue;
                }

                if (!validateAcyclicGraph(parsed.data.tasks)) {
                    // Auto-heal circular dependency by removing backwards dependencies
                    parsed.data.tasks.forEach((task, idx) => {
                        const allowedPriorKeys = new Set(parsed.data.tasks.slice(0, idx).map((t) => t.nodeKey));
                        task.dependencies = task.dependencies.filter((d) => allowedPriorKeys.has(d));
                    });
                }

                validatedPlan = parsed.data;
                if (planCache.size < MAX_CACHE_SIZE) {
                    planCache.set(cacheKey, validatedPlan);
                }
                break;
            } catch (error) {
                lastPlannerError = error;
                console.error(`❌ [Planner Attempt Error]:`, error.message);
                if (['LLM_UNAVAILABLE', 'LLM_ERROR'].includes(error.code) || error.status === 503 || error.status === 401) {
                    break;
                }
                currentPrompt = `An error occurred: ${error.message}. Generate valid DAG JSON for this goal:\n${goalPrompt}`;
            }
        }

        if (!validatedPlan) {
            await updateExecutionRunStatus(runId, 'FAILED');

            const errorMessage = lastPlannerError?.message || 'Failed to generate a valid acyclic DAG plan after maximum attempts.';
            const error = new Error(errorMessage);
            error.code = [500, 502, 503, 504].includes(Number(lastPlannerError?.code)) || lastPlannerError?.code === 'LLM_UNAVAILABLE'
                ? 'LLM_UNAVAILABLE'
                : 'PLANNER_ERROR';
            error.cause = lastPlannerError;
            throw error;
        }
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

    emitWorkflowEvent({
        io,
        runId,
        event: 'run_started',
        source: 'PLANNER',
        payload: {
            runId,
            title: validatedPlan.workflowTitle,
            summary: validatedPlan.summary,
            tasks: validatedPlan.tasks,
        },
    });

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
    normalizePlan,
    validatePlan,
    planWorkflowRun,
};
