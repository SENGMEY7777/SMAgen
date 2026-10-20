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
const IMAGE_GENERATOR_TOOL = 'imageGenerator';
const IMAGE_INTENT_PATTERN = /\b(?:generate|create|draw|design|make|render)\b[\s\S]{0,120}\b(?:image|logo|icon|banner|illustration|artwork|picture|poster)\b/i;
const IMAGE_KEYWORD_PATTERN = /\b(?:image|logo|icon|banner|illustration|artwork|picture|poster)\b/i;
const IMAGE_URL_INTENT_PATTERN = /\b(?:image|images|photo|photos|picture|pictures|banner|banners|asset|assets)\b[\s\S]{0,100}\b(?:url|urls|link|links|remote|external|cdn)\b|\b(?:use|using|with|from)\s+(?:an?\s+)?(?:image\s+)?(?:url|urls|link|links)\b/i;
const DESKTOP_ASSET_INTENT_PATTERN = /\b(?:list|read|inspect|scan|find|load|use|utili[sz]e|map|import|copy)\b[\s\S]{0,120}\b(?:asset|image|banner|product|file|folder|directory)\b/i;
const DESKTOP_PATH_PATTERN = /(?:~[\\/]\s*|\/Users\/[^\s/'"`]+[\\/])?Desktop[\\/]+([^\s'"`]+(?:[\\/][^\s'"`]+)*)/i;

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

const isExplicitDesktopWriteRequest = (value) => {
    const text = String(value || '');
    const hasWriteVerb = /\b(?:create|make|add|write|save|put|place|export|copy)\b/i.test(text);
    const hasDesktopTarget = /\bdesktop\b/i.test(text);
    const hasFileOrDirectoryTarget = /\b(?:file|files|folder|directory|project)\b/i.test(text);

    return LOCAL_DESKTOP_OUTPUT_ENABLED && hasWriteVerb && hasDesktopTarget && hasFileOrDirectoryTarget;
};

const isDesktopExportRequest = (value) => {
    const text = String(value || '');

    return LOCAL_DESKTOP_OUTPUT_ENABLED
        && ((/\b(?:local\s+computer|finder)\b/i.test(text)
                && /\b(?:show|save|export|copy|folder|directory|project|files?)\b/i.test(text))
            || /\b(?:show|export|copy|save)\b[\s\S]{0,80}\b(?:folder|directory|project|files?|desktop)\b/i.test(text));
};

const isDesktopOutputRequest = (value) => {
    return isExplicitDesktopWriteRequest(value) || isDesktopExportRequest(value);
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
    const targetsDesktop = isExplicitDesktopWriteRequest(targetText);

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

const cleanDesktopRelativePath = (value) => {
    if (typeof value !== 'string') {
        return null;
    }

    let cleaned = value
        .trim()
        .replace(/^['"`]|['"`]$/g, '')
        .replace(/[.,;!?]+$/, '')
        .replace(/[\\/]$/, '');

    const desktopMatch = cleaned.match(/(?:^|[\\/])Desktop[\\/]+(.+)$/i);
    if (desktopMatch) {
        cleaned = desktopMatch[1];
    }

    cleaned = cleaned.replace(/^~[\\/]+/, '');

    if (
        !cleaned
        || cleaned.startsWith('/')
        || /^[A-Za-z]:[\\/]/.test(cleaned)
        || cleaned.split(/[\\/]/).includes('..')
        || cleaned.includes('\0')
    ) {
        return null;
    }

    return cleaned.replace(/\\/g, '/');
};

const inferDesktopAssetPath = (task, goalPrompt) => {
    const toolInput = task.toolInput || {};
    const directCandidates = [
        toolInput.path,
        toolInput.directory,
        toolInput.directoryPath,
        toolInput.root,
    ];

    for (const candidate of directCandidates) {
        const normalized = cleanDesktopRelativePath(candidate);
        if (normalized && normalized !== '.') {
            return normalized;
        }
    }

    const commandTokens = String(toolInput.command || '').match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g) || [];
    const text = `${goalPrompt || ''} ${task.title || ''} ${task.instruction || ''}`;
    const textCandidates = [...commandTokens, text.match(DESKTOP_PATH_PATTERN)?.[0]];

    for (const candidate of textCandidates) {
        const normalized = cleanDesktopRelativePath(candidate);
        if (normalized && (/[\\/]Desktop[\\/]/i.test(String(candidate)) || /Desktop/i.test(String(candidate)))) {
            return normalized;
        }
    }

    return 'E-Commerce';
};

const isDesktopAssetTask = (task, goalPrompt) => {
    const toolInput = task.toolInput || {};
    const taskText = `${task.title || ''} ${task.instruction || ''} ${JSON.stringify(toolInput)}`;
    const goalText = String(goalPrompt || '');
    const referencesDesktop = /\bdesktop\b/i.test(taskText)
        || /(?:~[\\/]|\/Users\/[^\s/'"`]+[\\/])Desktop[\\/]/i.test(taskText)
        || (/\bdesktop\b/i.test(goalText) && /\b(?:local assets|asset folder)\b/i.test(taskText));

    return referencesDesktop
        && (DESKTOP_ASSET_INTENT_PATTERN.test(taskText)
            || /\b(?:local assets|product images|banner images|asset folder)\b/i.test(taskText));
};

const normalizeDesktopAssetTasks = (tasks, goalPrompt) => tasks.map((task) => {
    if (!isDesktopAssetTask(task, goalPrompt)) {
        return task;
    }

    const taskText = `${goalPrompt || ''} ${task.title || ''} ${task.instruction || ''}`;
    const wantsImagesOnly = /\b(?:image|images|banner|product)\b/i.test(taskText);
    const remoteImageUrls = wantsRemoteImageUrls(goalPrompt);

    return {
        ...task,
        assignedTool: 'fileManager',
        toolInput: {
            action: 'listDesktopDirectory',
            path: inferDesktopAssetPath(task, goalPrompt),
            ...(wantsImagesOnly ? {imagesOnly: true} : {}),
            ...(remoteImageUrls ? {allowMissing: true} : {}),
        },
    };
});

const shouldExportWorkspaceToDesktop = (goalPrompt, tasks) => {
    if (!isDesktopOutputRequest(goalPrompt)) {
        return false;
    }

    const hasExistingDesktopFileOutput = tasks.some((task) => {
        const action = String(task.toolInput?.action || '').trim().toLowerCase();
        return action === 'createdesktopfile' || action === 'create_desktop_file'
            || action === 'exportworkspacetodesktop' || action === 'export_workspace_to_desktop';
    });

    return !hasExistingDesktopFileOutput;
};

const appendDesktopExportTask = (tasks, goalPrompt) => {
    if (!shouldExportWorkspaceToDesktop(goalPrompt, tasks)) {
        return tasks;
    }

    const existingKeys = new Set(tasks.map((task) => task.nodeKey));
    let nodeKey = 'export_desktop';
    let suffix = 2;
    while (existingKeys.has(nodeKey)) {
        nodeKey = `export_desktop_${suffix}`;
        suffix += 1;
    }

    return [
        ...tasks,
        {
            nodeKey,
            title: 'Export generated project to Desktop',
            instruction: 'Copy the completed workflow workspace to a local Desktop folder named kairo-ecommerce.',
            dependencies: tasks.map((task) => task.nodeKey),
            assignedTool: 'fileManager',
            toolInput: {
                action: 'exportWorkspaceToDesktop',
                path: process.env.LOCAL_DESKTOP_OUTPUT_DIR || 'kairo-ecommerce',
            },
        },
    ];
};

const isDesktopDirectoryTask = (task) => {
    const action = String(task.toolInput?.action || '').trim().toLowerCase();
    return action === 'createdesktopdirectory' || action === 'create_desktop_directory';
};

const normalizeDesktopFileTasks = (tasks, goalPrompt) => {
    const desktopDirectoryTasks = tasks.filter(isDesktopDirectoryTask);
    const desktopGoal = isExplicitDesktopWriteRequest(goalPrompt);

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

const cleanImageFileName = (value) => {
    if (typeof value !== 'string') {
        return null;
    }

    const fileName = value.trim().replace(/^['"`]|['"`]$/g, '');
    if (
        !fileName
        || fileName.startsWith('.')
        || fileName.includes('/')
        || fileName.includes('\\')
        || fileName.includes('..')
    ) {
        return null;
    }

    return /\.(?:png|jpe?g|webp)$/i.test(fileName) ? fileName : `${fileName}.png`;
};

const inferImageFileName = (task, toolInput) => {
    const directFileName = cleanImageFileName(toolInput.fileName);
    if (directFileName) {
        return directFileName;
    }

    const pathFileName = cleanImageFileName(toolInput.path);
    if (pathFileName) {
        return pathFileName;
    }

    const taskText = `${task.title || ''} ${task.instruction || ''}`;
    const quotedFileName = taskText.match(/\b(?:file|filename)\b[\s\S]{0,40}["']([^"']+)["']/i);
    return cleanImageFileName(quotedFileName?.[1]) || 'generated-image.png';
};

const isImageGenerationTask = (task) => {
    const toolInput = task.toolInput || {};
    const taskText = `${task.title || ''} ${task.instruction || ''} ${toolInput.prompt || ''}`;
    return IMAGE_INTENT_PATTERN.test(taskText)
        || (IMAGE_KEYWORD_PATTERN.test(taskText) && /\b(?:generate|create|draw|design|make|render)\b/i.test(taskText));
};

const wantsRemoteImageUrls = (goalPrompt) => IMAGE_URL_INTENT_PATTERN.test(String(goalPrompt || ''));

const normalizeNonImageTask = (task) => {
    const toolInput = task.toolInput || {};
    const action = String(toolInput.action || '').trim().toLowerCase();
    const taskText = `${task.title || ''} ${task.instruction || ''}`;

    if (typeof toolInput.command === 'string' && toolInput.command.trim()) {
        return {
            ...task,
            assignedTool: 'executeCommand',
        };
    }

    if (['read', 'list', 'search', 'get', 'create', 'write', 'update', 'append', 'delete', 'remove', 'mkdir', 'createdirectory', 'create_directory'].includes(action)) {
        return {
            ...task,
            assignedTool: 'fileManager',
        };
    }

    if (/\b(?:list|show|inspect|scan|find)\b[\s\S]{0,80}\b(?:asset|file|folder|directory|workspace)\b/i.test(taskText)) {
        return {
            ...task,
            assignedTool: 'fileManager',
            toolInput: {
                ...toolInput,
                action: 'list',
                path: cleanRelativeFilePath(toolInput.path) || '.',
            },
        };
    }

    if (/\b(?:file|html|json|css|javascript|homepage|webpage|metadata|project structure|directory|folder)\b/i.test(taskText)) {
        const isDirectoryTask = /\b(?:directory|folder|project structure)\b/i.test(taskText);
        const mentionedFile = taskText.match(/\b[A-Za-z0-9_-]+\.(?:html?|json|css|js|mjs|cjs|ts|tsx|jsx|md|txt)\b/i)?.[0];
        return {
            ...task,
            assignedTool: 'fileManager',
            toolInput: {
                ...toolInput,
                action: isDirectoryTask ? 'createDirectory' : 'create',
                path: cleanRelativeFilePath(toolInput.path)
                    || cleanRelativeFilePath(toolInput.fileName)
                    || cleanRelativeFilePath(mentionedFile)
                    || (isDirectoryTask ? 'project' : 'output.txt'),
            },
        };
    }

    // Never allow a non-visual task to execute through the image provider.
    return {
        ...task,
        assignedTool: 'fileManager',
        toolInput: {
            ...toolInput,
            action: 'list',
            path: '.',
        },
    };
};

const normalizeImageTasks = (tasks, goalPrompt) => {
    const imageGoal = IMAGE_INTENT_PATTERN.test(String(goalPrompt || ''));
    const remoteImageUrls = wantsRemoteImageUrls(goalPrompt);

    return tasks.map((task) => {
        const imageTask = isImageGenerationTask(task);

        if (task.assignedTool === IMAGE_GENERATOR_TOOL && !imageTask) {
            return normalizeNonImageTask(task);
        }

        if (!imageGoal && !imageTask) {
            return task;
        }

        if (!imageTask) {
            return task;
        }

        const toolInput = task.toolInput || {};
        const prompt = typeof toolInput.prompt === 'string' && toolInput.prompt.trim()
            ? toolInput.prompt.trim()
            : String(task.instruction || task.title || goalPrompt).trim();
        const aspectRatio = ['1:1', '16:9', '9:16', '4:3', '3:4'].includes(toolInput.aspectRatio)
            ? toolInput.aspectRatio
            : '1:1';

        return {
            ...task,
            assignedTool: IMAGE_GENERATOR_TOOL,
            toolInput: {
                ...toolInput,
                prompt,
                fileName: inferImageFileName(task, toolInput),
                aspectRatio,
                ...(remoteImageUrls ? {outputMode: 'url'} : {}),
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
        // Desktop asset discovery must use the constrained fileManager path, never a shell command.
        plan.tasks = normalizeDesktopAssetTasks(plan.tasks, goalPrompt);
        plan.tasks = normalizeImageTasks(plan.tasks, goalPrompt);
        // Local development users should be able to open the generated project in Finder.
        plan.tasks = appendDesktopExportTask(plan.tasks, goalPrompt);
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
            ? `- Local Desktop access is enabled for development. For a request to create a folder directly on the Mac Desktop, use fileManager with {"action":"createDesktopDirectory","path":"folder-name"}. To list local assets, use fileManager with {"action":"listDesktopDirectory","path":"E-Commerce","imagesOnly":true}; to export a completed project for Finder, use fileManager with {"action":"exportWorkspaceToDesktop","path":"kairo-ecommerce"}; never use executeCommand for Desktop paths.`
            : '- Host Desktop output is disabled. Use fileManager action createDirectory with a relative path inside the workflow workspace; never target a host Desktop.';
        const systemPrompt = `
You are KAIRO, an autonomous AI workflow planner.
Decompose the user goal into a Directed Acyclic Graph (DAG) of executable subtasks.
Available Tools:
1. 'executeCommand' - Run allowlisted, read-only workspace commands such as cat, head, tail, grep, ls, pwd, find, and wc. Never use executeCommand or mkdir for directory creation; use fileManager instead.
2. 'fileManager' - Create, edit, read, list, delete files, create workspace directories, access a local Desktop directory, or export a completed workspace to the local Desktop when explicitly enabled. Use {"action":"createDirectory","path":"relative/directory"} for workspace directories, {"action":"listDesktopDirectory","path":"E-Commerce","imagesOnly":true} to list local Desktop image assets, and {"action":"exportWorkspaceToDesktop","path":"kairo-ecommerce"} to export the completed project.
3. 'webSearch' - Query DuckDuckGo; set toolInput.scrape=true when page HTML should be converted to Markdown.
4. 'databaseConnector' - Execute parameterized SQL with toolInput.sql and toolInput.params.
5. 'httpRequester' - Make HTTP/HTTPS API calls with toolInput.method, url, headers, params, and data.
6. 'imageGenerator' - Generate images, UI mockups, banners, or logos with toolInput.prompt, toolInput.fileName, toolInput.aspectRatio ('1:1', '16:9', '9:16', '4:3'), and optional toolInput.outputMode ('file', 'url', or 'both').

Rules:
- Assign dependencies logically (for example, task_2 depends on ['task_1']).
- Never create circular dependencies.
- Every dependency must reference an existing nodeKey.
- Never use an absolute path or a path containing '..'. The executor enforces either the workspace boundary or the explicitly enabled local Desktop boundary.
- For regular directory creation, prefer the fileManager tool with action 'createDirectory'.
- Never assign executeCommand to a directory or folder creation task.
- For requests to generate a visual image, logo, icon, banner, illustration, or artwork, assign imageGenerator. Do not answer with a textual design description or use fileManager to create an SVG unless the user explicitly requests source code.
- Use imageGenerator only for visual image, logo, icon, banner, illustration, or artwork generation. Never use it for HTML, JSON, CSS, JavaScript, metadata, project structure, file creation, or asset listing.
- If the goal asks for image links, image URLs, remote images, external images, or CDN images, set imageGenerator toolInput.outputMode to 'url'. When creating HTML, use the returned imageUrl directly in img src, CSS background-image, hero slides, product cards, and category cards.
- For a Vue page with multiple components, use fileManager action 'createFiles' with a files array of {path, content} objects; do not invent createFile, writeFile, or writefile actions.
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
