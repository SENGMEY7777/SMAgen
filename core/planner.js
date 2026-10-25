const crypto = require('crypto');
const path = require('path');

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
const extractHomepageTopic = (goalPrompt) => {
    const text = String(goalPrompt || '').replace(/\s+/g, ' ').trim();
    const quotedMatch = text.match(
        /\b(?:about|focused on|centered on|featuring|showcasing|for)\s+["']([^"']+)["']/i,
    );
    const unquotedMatch = text.match(
        /\b(?:about|focused on|centered on|featuring|showcasing|for)\s+([^?.!,]+?)(?=\s+(?:have|has|with|display|displaying|show|showing|containing|including)\b|[?.!,]|$)/i,
    );
    const topic = (quotedMatch?.[1] || unquotedMatch?.[1] || '').trim();

    return topic
        .replace(/^(?:a|an|the)\s+/i, '')
        .replace(/\s+/g, ' ')
        .slice(0, 64)
        .trim();
};

const PRODUCT_COUNT_WORDS = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
};

const extractProductCount = (goalPrompt) => {
    const text = String(goalPrompt || '').replace(/\s+/g, ' ').trim();
    const match = text.match(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+products?\b/i);
    if (!match) return 0;

    const value = /^\d+$/.test(match[1])
        ? Number(match[1])
        : PRODUCT_COUNT_WORDS[match[1].toLowerCase()];
    return Math.min(Math.max(value || 0, 1), 10);
};

const IMAGE_INTENT_PATTERN = /\b(?:generate|create|draw|design|make|render)\b[\s\S]{0,120}\b(?:image|logo|icon|banner|illustration|artwork|picture|poster)\b/i;
const IMAGE_KEYWORD_PATTERN = /\b(?:image|logo|icon|banner|illustration|artwork|picture|poster)\b/i;
const IMAGE_URL_INTENT_PATTERN = /\b(?:image|images|photo|photos|picture|pictures|logo|logos|icon|icons|banner|banners|asset|assets)\b[\s\S]{0,100}\b(?:url|urls|link|links|remote|external|cdn)\b|\b(?:use|using|with|from)\s+(?:an?\s+)?(?:image|logo|icon|banner)?\s*(?:url|urls|link|links)\b/i;
const DESKTOP_ASSET_INTENT_PATTERN = /\b(?:list|read|inspect|scan|find|load|use|utili[sz]e|map|import|copy)\b[\s\S]{0,120}\b(?:asset|image|banner|product|file|folder|directory)\b/i;
const LOCAL_DESTINATION_PATH_PATTERN = /\b(?:desktop|downloads?)[\\/]+([A-Za-z0-9._-]+(?:[\\/][A-Za-z0-9._-]+)*)/i;
const DESKTOP_PATH_PATTERN = /(?:~[\\/]\s*|\/Users\/[^\s/'"`]+[\\/])?Desktop[\\/]+([^\s'"`]+(?:[\\/][^\s'"`]+)*)/i;

const isHtmlSourceRequest = (goalPrompt) => {
    const text = String(goalPrompt || '');
    return /\b(?:html?|homepage|web\s*page|website|landing\s+page)\b/i.test(text)
        && /\b(?:create|generate|build|make|add|insert|write|design|setup|set\s+up|update|modify|change|edit)\b/i.test(text);
};

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
    const localDestinationMatch = taskText.match(LOCAL_DESTINATION_PATH_PATTERN);

    if (localDestinationMatch) {
        return cleanRelativeDirectoryPath(localDestinationMatch[1].replace(/[.,;!?]+$/, ''));
    }

    const quotedName = taskText.match(
        /\b(?:directory|folder|project)\b[\s\S]{0,80}\b(?:named|called|name)\b(?:\s+is)?\s*["']([^"']+)["']/i,
    );

    if (quotedName) {
        return cleanRelativeDirectoryPath(quotedName[1]);
    }

    const plainName = taskText.match(
        /\b(?:directory|folder|project)\b[\s\S]{0,80}\b(?:named|called|name)\b(?:\s+is)?\s+([A-Za-z0-9_-]+)(?=\s+(?:on|in|inside|with|and|i\s+want)\b|[.,;!?]|$)/i,
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
        && ((/\bfinder\b/i.test(text)
                && /\b(?:show|save|export|copy|folder|directory|project|files?)\b/i.test(text))
            || /\b(?:show|export|copy|save)\b[\s\S]{0,80}\b(?:folder|directory|project|files?|desktop)\b/i.test(text));
};

const isDownloadsOutputRequest = (value) => {
    const text = String(value || '');

    return LOCAL_DESKTOP_OUTPUT_ENABLED
        && (/\b(?:download|downloads|downloaded)\b/i.test(text)
            || /\b(?:save|store|put)\b[\s\S]{0,60}\b(?:locally|local\s+computer|my\s+computer)\b/i.test(text)
            || /\blocal\s+computer\b/i.test(text));
};

const isDesktopOutputRequest = (value) => {
    return isExplicitDesktopWriteRequest(value) || isDesktopExportRequest(value);
};

const isOutputProducingTask = (task) => {
    const tool = String(task.assignedTool || '').trim().toLowerCase();
    const action = String(task.toolInput?.action || '').trim().toLowerCase();
    const text = String(task.instruction || task.title || task.description || '');

    if (tool === 'imagegenerator' || tool === 'image_generator') {
        return true;
    }

    if (tool === 'filemanager' || tool === 'file_manager') {
        return new Set([
            'createfile',
            'createfiles',
            'writefile',
            'appendfile',
            'updatefile',
            'copyfile',
            'createdesktopfile',
            'exportworkspacetodesktop',
            'exportworkspacetodownloads',
        ]).has(action);
    }

    return (tool === 'executecommand' || tool === 'execute_command')
        && /\b(?:create|generate|build|scaffold|write|save|export|compile|install)\b/i.test(text);
};

const hasLocalExportTask = (tasks) => tasks.some((task) => {
    const tool = String(task.assignedTool || '').trim().toLowerCase();
    const action = String(task.toolInput?.action || '').trim().toLowerCase();

    return (tool === 'filemanager' || tool === 'file_manager')
        && /^(?:exportworkspacetodesktop|exportworkspacetodownloads)$/.test(action);
});

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

    return cleanRelativeDirectoryPath(
        inferDirectoryPath({title: '', instruction: ''}, {}, goalPrompt),
    ) || '.';
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
    if (isVueProjectSetupRequest(goalPrompt)) {
        return tasks;
    }

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

    const exportPath = cleanRelativeDirectoryPath(
        inferDirectoryPath({title: '', instruction: ''}, {}, goalPrompt),
    ) || process.env.LOCAL_DESKTOP_OUTPUT_DIR || 'generated-workflow';

    return [
        ...tasks,
        {
            nodeKey,
            title: `Export generated output to Desktop/${exportPath}`,
            instruction: `Copy the completed workflow output to the local Desktop folder ${exportPath}, excluding generated node_modules dependencies.`,
            dependencies: tasks.map((task) => task.nodeKey),
            assignedTool: 'fileManager',
            toolInput: {
                action: 'exportWorkspaceToDesktop',
                path: exportPath,
            },
        },
    ];
};

const appendDownloadsExportTask = (tasks, goalPrompt) => {
    if (
        !LOCAL_DESKTOP_OUTPUT_ENABLED
        || isDesktopOutputRequest(goalPrompt)
        || hasLocalExportTask(tasks)
    ) {
        return tasks;
    }

    if (!isDownloadsOutputRequest(goalPrompt) && !tasks.some(isOutputProducingTask)) {
        return tasks;
    }

    const exportPath = cleanRelativeDirectoryPath(
        inferDirectoryPath({title: '', instruction: ''}, {}, goalPrompt),
    ) || cleanRelativeDirectoryPath(process.env.LOCAL_DOWNLOAD_OUTPUT_DIR) || 'kairo-workflow';

    const existingKeys = new Set(tasks.map((task) => task.nodeKey));
    let nodeKey = 'export_downloads';
    let suffix = 2;
    while (existingKeys.has(nodeKey)) {
        nodeKey = `export_downloads_${suffix}`;
        suffix += 1;
    }

    return [
        ...tasks,
        {
            nodeKey,
            title: `Export generated output to Downloads/${exportPath}`,
            instruction: `Copy the completed workflow output to the local Downloads folder ${exportPath}, excluding generated node_modules dependencies.`,
            dependencies: tasks.map((task) => task.nodeKey),
            assignedTool: 'fileManager',
            toolInput: {
                action: 'exportWorkspaceToDownloads',
                path: exportPath,
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

const isIndexHtmlRequest = (goalPrompt) => {
    const text = String(goalPrompt || '');
    return LOCAL_DESKTOP_OUTPUT_ENABLED
        && /\bindex\.html\b/i.test(text)
        && /\b(?:create|generate|build|make|write)\b/i.test(text)
        && /\b(?:landing\s+page|homepage|web\s*page|website|html)\b/i.test(text);
};

const ensureDesktopIndexTask = (tasks, goalPrompt) => {
    if (!isIndexHtmlRequest(goalPrompt)) {
        return tasks;
    }

    const directoryPath = cleanRelativeDirectoryPath(
        tasks.find(isDesktopDirectoryTask)?.toolInput?.path
            || inferDirectoryPath({title: '', instruction: ''}, {}, goalPrompt),
    );

    if (!directoryPath) {
        return tasks;
    }

    const nextTasks = [...tasks];
    let directoryTask = nextTasks.find((task) => (
        isDesktopDirectoryTask(task)
        && cleanRelativeDirectoryPath(task.toolInput?.path) === directoryPath
    ));

    if (!directoryTask) {
        const existingKeys = new Set(nextTasks.map((task) => task.nodeKey));
        let nodeKey = 'create_desktop_directory';
        let suffix = 2;
        while (existingKeys.has(nodeKey)) {
            nodeKey = `create_desktop_directory_${suffix}`;
            suffix += 1;
        }

        directoryTask = {
            nodeKey,
            title: `Create Desktop directory ${directoryPath}`,
            instruction: `Create a directory named ${directoryPath} on the local Desktop.`,
            dependencies: [],
            assignedTool: 'fileManager',
            toolInput: {
                action: 'createDesktopDirectory',
                path: directoryPath,
            },
        };
        nextTasks.unshift(directoryTask);
    }

    const isIndexTask = (task) => {
        const taskPath = String(task.toolInput?.path || '').replace(/\\/g, '/');
        const taskText = `${task.title || ''} ${task.instruction || ''} ${taskPath}`;
        return /(?:^|\/)index\.html$/i.test(taskPath) || /\bindex\.html\b/i.test(taskText);
    };

    const existingIndexTask = nextTasks.find(isIndexTask);
    if (existingIndexTask) {
        const requestedPath = cleanRelativeFilePath(existingIndexTask.toolInput?.path) || 'index.html';
        const desktopPath = requestedPath === directoryPath || requestedPath.startsWith(`${directoryPath}/`)
            ? requestedPath
            : `${directoryPath}/${requestedPath}`;

        return nextTasks.map((task) => {
            if (task !== existingIndexTask) {
                return task;
            }

            return {
                ...task,
                title: `Create ${directoryPath}/index.html homepage`,
                instruction: `Create a homepage for ${extractHomepageTopic(goalPrompt) || 'the requested subject'} in ${directoryPath}/index.html.`,
                assignedTool: 'fileManager',
                dependencies: [...new Set([...(task.dependencies || []), directoryTask.nodeKey])],
                toolInput: {
                    ...task.toolInput,
                    action: DESKTOP_FILE_ACTION,
                    mode: task.toolInput?.mode || 'create',
                    path: desktopPath,
                },
            };
        });
    }

    const existingKeys = new Set(nextTasks.map((task) => task.nodeKey));
    let nodeKey = 'create_desktop_index_html';
    let suffix = 2;
    while (existingKeys.has(nodeKey)) {
        nodeKey = `create_desktop_index_html_${suffix}`;
        suffix += 1;
    }

    return [
        ...nextTasks,
        {
            nodeKey,
            title: `Create ${directoryPath}/index.html homepage`,
            instruction: `Create a homepage for ${extractHomepageTopic(goalPrompt) || 'the requested subject'} in ${directoryPath}/index.html.`,
            dependencies: [directoryTask.nodeKey],
            assignedTool: 'fileManager',
            toolInput: {
                action: DESKTOP_FILE_ACTION,
                mode: 'create',
                path: `${directoryPath}/index.html`,
                content: '',
            },
        },
    ];
};

const isDynamicHomepageImageRequest = (goalPrompt) => {
    const text = String(goalPrompt || '');
    return isIndexHtmlRequest(goalPrompt)
        && /\b(?:image|images|photo|photos|picture|pictures|logo|logos|icon|icons|banner|banners|url|urls|link|links|remote|external|cdn)\b/i.test(text);
};

const isLogoRequest = (goalPrompt) => /\b(?:logo|logos|brand\s+mark|wordmark|logomark|favicon)\b/i.test(String(goalPrompt || ''));

const createHomepageImagePrompt = (goalPrompt, index, {logo = false} = {}) => {
    const brief = String(goalPrompt || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
    const assetDescription = logo
        ? 'a clean, recognizable brand logo or mark'
        : 'a polished website image that matches the requested subject';
    const logoRules = logo
        ? 'Use a simple silhouette, strong contrast, and a transparent or plain background. Do not render a product mockup, browser screenshot, watermark, or unrelated text.'
        : 'Use the requested subject, style, colors, composition, and mood. Do not add unrelated subjects, watermarks, or logos unless the user explicitly requested them.';

    return `Create ${assetDescription} for image asset ${index + 1}, following this user brief exactly: "${brief}". ${logoRules} Return the visual asset itself, not a written explanation.`;
};

const normalizeHomepageImageReferences = (content, imagePrefix) => {
    if (typeof content !== 'string' || !content.trim()) {
        return content;
    }

    let imageIndex = 0;
    const nextPlaceholder = () => {
        imageIndex += 1;
        return `{{imageUrl:${imagePrefix}${imageIndex}}}`;
    };

    let normalized = content.replace(/\{\{imageUrl:[A-Za-z0-9_-]+\}\}/g, nextPlaceholder);
    normalized = normalized.replace(/(<img\b[^>]*\bsrc\s*=\s*)(["'])([^"']*)(\2)/gi, (match, prefix, quote, source) => {
        if (/\{\{imageUrl:[A-Za-z0-9_-]+\}\}/i.test(source)) {
            return match;
        }

        return /^https?:\/\//i.test(source.trim())
            ? `${prefix}${quote}${nextPlaceholder()}${quote}`
            : match;
    });
    normalized = normalized.replace(/url\(\s*(["']?)(https?:\/\/[^)"']+)\1\s*\)/gi, (match, quote) => {
        return `url(${quote}${nextPlaceholder()}${quote})`;
    });

    return normalized;
};

const escapeHtmlAttribute = (value) => String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&#39;');

const injectHomepageImagePlaceholder = (content, goalPrompt, imagePrefix) => {
    const topic = extractHomepageTopic(goalPrompt) || 'requested subject';
    const alt = escapeHtmlAttribute(`${topic} image`);
    const markup = `\n<section class="generated-image" aria-label="${alt}">\n  <img src="{{imageUrl:${imagePrefix}1}}" alt="${alt}" loading="lazy" />\n</section>\n`;
    const closingTag = String(content || '').match(/<\/(?:main|body)>/i);

    if (closingTag && closingTag.index !== undefined) {
        return `${content.slice(0, closingTag.index)}${markup}${content.slice(closingTag.index)}`;
    }

    return `${content}${markup}`;
};

const ensureHomepageImageTasks = (tasks, goalPrompt) => {
    if (!isDynamicHomepageImageRequest(goalPrompt)) {
        return tasks;
    }

    const indexTask = tasks.find((task) => {
        const taskPath = String(task.toolInput?.path || '').replace(/\\/g, '/');
        return /(?:^|\/)index\.html$/i.test(taskPath) || /\bindex\.html\b/i.test(`${task.title || ''} ${task.instruction || ''}`);
    });

    if (!indexTask) {
        return tasks;
    }

    const isProductHomepage = /\b(?:product|products|catalog|shop|store|collection)\b/i.test(String(goalPrompt || ''));
    const logoHomepage = isLogoRequest(goalPrompt) && !isProductHomepage;
    const imagePrefix = logoHomepage ? 'homepage_logo_image_' : (isProductHomepage ? 'homepage_product_image_' : 'homepage_feature_image_');
    const originalContent = typeof indexTask.toolInput?.content === 'string'
        ? indexTask.toolInput.content
        : '';
    let normalizedContent = normalizeHomepageImageReferences(originalContent, imagePrefix);
    let placeholderKeys = [...new Set(
        [...normalizedContent.matchAll(/\{\{imageUrl:([A-Za-z0-9_-]+)\}\}/g)].map((match) => match[1]),
    )];
    if (!placeholderKeys.length) {
        normalizedContent = injectHomepageImagePlaceholder(normalizedContent, goalPrompt, imagePrefix);
        placeholderKeys = [...new Set(
            [...normalizedContent.matchAll(/\{\{imageUrl:([A-Za-z0-9_-]+)\}\}/g)].map((match) => match[1]),
        )];
    }

    if (!placeholderKeys.length) {
        throw new Error('Unable to add a dynamic image placeholder to index.html for the requested image URL.');
    }

    const count = Math.max(
        extractProductCount(goalPrompt) || (isProductHomepage ? 3 : 1),
        placeholderKeys.length,
    );
    const directoryTask = tasks.find(isDesktopDirectoryTask);
    const homepageImageTaskPattern = /^homepage_(?:product|feature|logo)_image_/;
    const existingImageTasks = tasks.filter((task) => String(task.nodeKey || '').startsWith(imagePrefix));
    const imageTasks = [];

    for (let index = 0; index < count; index += 1) {
        const nodeKey = `${imagePrefix}${index + 1}`;
        const existingTask = existingImageTasks.find((task) => task.nodeKey === nodeKey);

        imageTasks.push(existingTask || {
            nodeKey,
            title: `${logoHomepage ? 'Generate homepage logo' : 'Generate homepage image'} ${index + 1}`,
            instruction: `Generate a fresh remote image URL for ${logoHomepage ? 'the requested logo' : `image ${index + 1}`} in the requested homepage.`,
            dependencies: directoryTask ? [directoryTask.nodeKey] : [],
            assignedTool: IMAGE_GENERATOR_TOOL,
            toolInput: {
                prompt: createHomepageImagePrompt(goalPrompt, index, {logo: logoHomepage}),
                aspectRatio: logoHomepage ? '1:1' : '3:4',
                outputMode: 'url',
            },
        });
    }

    const imageNodeKeys = imageTasks.map((task) => task.nodeKey);
    const imageNodeKeySet = new Set(imageNodeKeys);
    const nextTasks = tasks
        .filter((task) => !homepageImageTaskPattern.test(String(task.nodeKey || '')) || imageNodeKeySet.has(task.nodeKey))
        .map((task) => task === indexTask
            ? {
                ...task,
                dependencies: [...new Set([...(task.dependencies || []), ...imageNodeKeys])],
                toolInput: {
                    ...task.toolInput,
                    content: normalizedContent,
                },
            }
            : task);

    return [
        ...nextTasks.filter((task) => !imageNodeKeySet.has(task.nodeKey)),
        ...imageTasks,
    ];
};

const ensureHomepageContent = (tasks, goalPrompt) => {
    if (!isIndexHtmlRequest(goalPrompt)) {
        return tasks;
    }

    const indexTask = tasks.find((task) => {
        const taskPath = String(task.toolInput?.path || '').replace(/\\/g, '/');
        return /(?:^|\/)index\.html$/i.test(taskPath) || /\bindex\.html\b/i.test(`${task.title || ''} ${task.instruction || ''}`);
    });
    const content = indexTask?.toolInput?.content;

    if (!indexTask || typeof content !== 'string' || !content.trim()) {
        throw new Error('The planner must generate complete index.html content from the user prompt; static homepage fallbacks are disabled.');
    }

    return tasks;
};

const extractDesktopFileNames = (goalPrompt) => {
    const text = String(goalPrompt || '');
    const candidates = new Set();
    const filePattern = /\b[A-Za-z0-9][A-Za-z0-9._-]*\.(?:html?|css|js|mjs|cjs|ts|tsx|jsx|json|java|py|go|rs|md|txt|vue|xml|yml|yaml|sql)\b/gi;

    for (const match of text.matchAll(filePattern)) {
        candidates.add(match[0]);
    }

    const quotedFilePattern = /\bfile\b[\s\S]{0,40}\b(?:named|called|name)\b\s*["']([^"']+)["']/gi;
    for (const match of text.matchAll(quotedFilePattern)) {
        candidates.add(match[1]);
    }

    return [...candidates]
        .map((candidate) => cleanRelativeFilePath(candidate))
        .filter((candidate) => candidate && !candidate.includes('/'))
        .filter((candidate, index, all) => all.indexOf(candidate) === index);
};

const extractRequestedHtmlFileName = (goalPrompt) => {
    return extractDesktopFileNames(goalPrompt)
        .find((fileName) => /\.html?$/i.test(fileName)) || null;
};

const getHtmlContentFromTask = (task, fileName) => {
    const toolInput = task.toolInput || {};

    if (typeof toolInput.content === 'string') {
        return toolInput.content;
    }

    const fileEntry = Array.isArray(toolInput.files)
        ? toolInput.files.find((entry) => {
            const entryPath = String(entry?.path || entry?.fileName || '').replace(/\\/g, '/');
            return path.basename(entryPath).toLowerCase() === fileName.toLowerCase();
        })
        : null;

    return typeof fileEntry?.content === 'string' ? fileEntry.content : null;
};

const ensureRequestedHtmlTask = (tasks, goalPrompt) => {
    if (
        !isHtmlSourceRequest(goalPrompt)
        || isExplicitDesktopWriteRequest(goalPrompt)
    ) {
        return tasks;
    }

    const fileName = extractRequestedHtmlFileName(goalPrompt);
    if (!fileName) {
        return tasks;
    }

    const existingTask = tasks.find((task) => {
        const taskPath = String(task.toolInput?.path || '').replace(/\\/g, '/');
        const taskText = `${task.title || ''} ${task.instruction || ''} ${taskPath}`.toLowerCase();
        return path.basename(taskPath).toLowerCase() === fileName.toLowerCase()
            || taskText.includes(fileName.toLowerCase())
            || (Array.isArray(task.toolInput?.files)
                && task.toolInput.files.some((entry) => (
                    path.basename(String(entry?.path || entry?.fileName || '').replace(/\\/g, '/')).toLowerCase()
                    === fileName.toLowerCase()
                )));
    });

    const content = existingTask ? getHtmlContentFromTask(existingTask, fileName) : null;
    if (!existingTask || typeof content !== 'string' || !content.trim()) {
        throw new Error(
            `The planner must create the requested ${fileName} source file with complete HTML content. Do not generate ${fileName}.png or use imageGenerator unless the user explicitly requests an image.`,
        );
    }

    if (existingTask.assignedTool === 'fileManager'
        && String(existingTask.toolInput?.action || '').trim().toLowerCase() === 'createfiles') {
        return tasks;
    }

    return tasks.map((task) => {
        if (task !== existingTask) {
            return task;
        }

        return {
            ...task,
            title: `Create ${fileName} homepage`,
            instruction: `Create the requested ecommerce homepage in ${fileName}.`,
            assignedTool: 'fileManager',
            toolInput: {
                ...task.toolInput,
                action: 'create',
                mode: task.toolInput?.mode || 'create',
                path: fileName,
                content,
            },
        };
    });
};

const ensureDesktopPromptFileTasks = (tasks, goalPrompt) => {
    if (!isExplicitDesktopWriteRequest(goalPrompt)) {
        return tasks;
    }

    const fileNames = extractDesktopFileNames(goalPrompt);
    if (!fileNames.length) {
        return tasks;
    }

    const directoryPath = cleanRelativeDirectoryPath(
        tasks.find(isDesktopDirectoryTask)?.toolInput?.path
            || inferDirectoryPath({title: '', instruction: ''}, {}, goalPrompt),
    );

    if (!directoryPath) {
        return tasks;
    }

    const nextTasks = [...tasks];
    let directoryTask = nextTasks.find((task) => (
        isDesktopDirectoryTask(task)
        && cleanRelativeDirectoryPath(task.toolInput?.path) === directoryPath
    ));

    if (!directoryTask) {
        const existingKeys = new Set(nextTasks.map((task) => task.nodeKey));
        let nodeKey = 'create_desktop_directory';
        let suffix = 2;
        while (existingKeys.has(nodeKey)) {
            nodeKey = `create_desktop_directory_${suffix}`;
            suffix += 1;
        }

        directoryTask = {
            nodeKey,
            title: `Create Desktop directory ${directoryPath}`,
            instruction: `Create a directory named ${directoryPath} on the local Desktop.`,
            dependencies: [],
            assignedTool: 'fileManager',
            toolInput: {
                action: 'createDesktopDirectory',
                path: directoryPath,
            },
        };
        nextTasks.unshift(directoryTask);
    }

    for (const fileName of fileNames) {
        const existingTask = nextTasks.find((task) => {
            const taskPath = String(task.toolInput?.path || '').replace(/\\/g, '/');
            const taskText = `${task.title || ''} ${task.instruction || ''} ${taskPath}`;
            return path.basename(taskPath).toLowerCase() === fileName.toLowerCase()
                || new RegExp(`\\b${fileName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`, 'i').test(taskText);
        });

        if (existingTask) {
            const requestedPath = cleanRelativeFilePath(existingTask.toolInput?.path) || fileName;
            const desktopPath = requestedPath === directoryPath || requestedPath.startsWith(`${directoryPath}/`)
                ? requestedPath
                : `${directoryPath}/${requestedPath}`;
            const existingContent = typeof existingTask.toolInput?.content === 'string'
                ? existingTask.toolInput.content.trim()
                : '';
            const isHomepageFile = /^index\.html?$/i.test(fileName) && isIndexHtmlRequest(goalPrompt);

            const taskIndex = nextTasks.indexOf(existingTask);
            nextTasks[taskIndex] = {
                ...existingTask,
                title: isHomepageFile
                    ? `Create ${directoryPath}/${fileName} homepage`
                    : `Create Desktop file ${fileName}`,
                instruction: isHomepageFile
                    ? `Create a homepage for ${extractHomepageTopic(goalPrompt) || 'the requested subject'} in ${directoryPath}/${fileName}.`
                    : `Create ${fileName} inside the Desktop directory ${directoryPath}.`,
                assignedTool: 'fileManager',
                dependencies: [...new Set([...(existingTask.dependencies || []), directoryTask.nodeKey])],
                toolInput: {
                    ...existingTask.toolInput,
                    action: DESKTOP_FILE_ACTION,
                    mode: existingTask.toolInput?.mode || 'create',
                    path: desktopPath,
                    // Preserve the content produced from the current user
                    // prompt. Do not replace it with a generic file template.
                    content: existingContent,
                },
            };
            continue;
        }

        const existingKeys = new Set(nextTasks.map((task) => task.nodeKey));
        const baseKey = `create_desktop_${path.basename(fileName).replace(/[^A-Za-z0-9]+/g, '_').toLowerCase()}`;
        let nodeKey = baseKey;
        let suffix = 2;
        while (existingKeys.has(nodeKey)) {
            nodeKey = `${baseKey}_${suffix}`;
            suffix += 1;
        }

        nextTasks.push({
            nodeKey,
            title: `Create Desktop file ${fileName}`,
            instruction: `Create ${fileName} inside the Desktop directory ${directoryPath}.`,
            dependencies: [directoryTask.nodeKey],
            assignedTool: 'fileManager',
            toolInput: {
                action: DESKTOP_FILE_ACTION,
                mode: 'create',
                path: `${directoryPath}/${fileName}`,
                // Missing source content is left empty rather than filled with
                // static Java/JSON/JS/Markdown boilerplate.
                content: '',
            },
        });
    }

    return nextTasks;
};

const isVueProjectSetupRequest = (goalPrompt) => {
    if (!LOCAL_DESKTOP_OUTPUT_ENABLED) {
        return false;
    }

    const text = String(goalPrompt || '');
    const mentionsVue = /\bvue(?:\.js)?\b|\bvue\s*3\b|\bvue3\b/i.test(text);
    const mentionsProject = /\b(?:project|app|application|starter|template)\b/i.test(text);
    const requestsSetup = /\b(?:setup|set\s+up|scaffold|initialize|init|create|generate|start)\b/i.test(text);

    return mentionsVue
        && mentionsProject
        && requestsSetup
        && /\bdesktop\b/i.test(text);
};

const isVueScaffoldTask = (task) => {
    const toolInput = task.toolInput || {};
    const text = `${task.title || ''} ${task.instruction || ''} ${toolInput.command || ''}`;

    return /(?:npm\s+(?:create|init)\s+vite|npx\s+create-vite|create-vue)/i.test(text)
        || (/(?:vue|vite)/i.test(text)
            && /\b(?:setup|set\s+up|scaffold|initialize|init|create|generate)\b/i.test(text)
            && /\b(?:project|app|application|starter)\b/i.test(text));
};

const isVueInstallTask = (task) => {
    const toolInput = task.toolInput || {};
    const text = `${task.title || ''} ${task.instruction || ''} ${toolInput.command || ''}`;

    return /\b(?:npm|pnpm|yarn|bun)\s+install\b/i.test(text)
        || (/(?:vue|vite)/i.test(text)
            && /\b(?:install|dependencies|packages)\b/i.test(text));
};

const getUniqueNodeKey = (tasks, baseKey) => {
    const existingKeys = new Set(tasks.map((task) => task.nodeKey));
    let nodeKey = baseKey;
    let suffix = 2;

    while (existingKeys.has(nodeKey)) {
        nodeKey = `${baseKey}_${suffix}`;
        suffix += 1;
    }

    return nodeKey;
};

// The command executor intentionally runs without a shell, so a planner
// command must contain exactly one executable invocation. Expand the safe,
// sequential `&&` form into dependent tasks before persistence.
const splitSequentialCommand = (command) => {
    if (typeof command !== 'string' || !command.includes('&&')) {
        return null;
    }

    const parts = [];
    let current = '';
    let quote = null;
    let escaped = false;

    for (let index = 0; index < command.length; index += 1) {
        const character = command[index];

        if (escaped) {
            current += character;
            escaped = false;
            continue;
        }

        if (character === '\\' && quote !== "'") {
            current += character;
            escaped = true;
            continue;
        }

        if ((character === '"' || character === "'") && (!quote || quote === character)) {
            quote = quote ? null : character;
            current += character;
            continue;
        }

        if (!quote && character === '&' && command[index + 1] === '&') {
            const part = current.trim();
            if (!part) return null;
            parts.push(part);
            current = '';
            index += 1;
            continue;
        }

        current += character;
    }

    const finalPart = current.trim();
    if (!finalPart) return null;
    parts.push(finalPart);

    return parts.length > 1 ? parts : null;
};

const normalizeChainedCommandTasks = (tasks) => {
    if (!Array.isArray(tasks) || !tasks.length) {
        return tasks;
    }

    const usedKeys = new Set(tasks.map((task) => task.nodeKey));
    const replacements = new Map();
    const internalDependencies = new Map();
    const expandedTasks = [];

    for (const task of tasks) {
        const commandParts = task.assignedTool === 'executeCommand'
            ? splitSequentialCommand(task.toolInput?.command)
            : null;

        if (!commandParts) {
            expandedTasks.push(task);
            continue;
        }

        let previousNodeKey = null;
        const expanded = commandParts.map((commandPart, index) => {
            let nodeKey = index === 0 ? task.nodeKey : `${task.nodeKey}_${index + 1}`;

            while (usedKeys.has(nodeKey) && nodeKey !== task.nodeKey) {
                nodeKey = `${task.nodeKey}_${index + 1}_${usedKeys.size}`;
            }
            usedKeys.add(nodeKey);

            const dependencies = index === 0
                ? [...task.dependencies]
                : [...task.dependencies, previousNodeKey];

            const nextTask = {
                ...task,
                nodeKey,
                title: commandParts.length > 1
                    ? `${task.title} (${index + 1}/${commandParts.length})`
                    : task.title,
                instruction: commandParts.length > 1
                    ? `Run command ${index + 1} of ${commandParts.length}: ${commandPart}`
                    : task.instruction,
                dependencies: [...new Set(dependencies.filter(Boolean))],
                toolInput: {
                    ...task.toolInput,
                    command: commandPart,
                },
            };

            internalDependencies.set(nodeKey, new Set(index === 0 ? [] : [previousNodeKey]));
            previousNodeKey = nodeKey;
            return nextTask;
        });

        replacements.set(task.nodeKey, previousNodeKey);
        expandedTasks.push(...expanded);
    }

    if (!replacements.size) {
        return expandedTasks;
    }

    return expandedTasks.map((task) => ({
        ...task,
        dependencies: [...new Set(task.dependencies
            .map((dependency) => internalDependencies.get(task.nodeKey)?.has(dependency)
                ? dependency
                : (replacements.get(dependency) || dependency))
            .filter((dependency) => dependency && dependency !== task.nodeKey))],
    }));
};

const ensureVueDesktopProjectTasks = (tasks, goalPrompt) => {
    if (!isVueProjectSetupRequest(goalPrompt)) {
        return tasks;
    }

    const requestedDirectoryPath = cleanRelativeDirectoryPath(
        inferDirectoryPath({title: '', instruction: ''}, {}, goalPrompt),
    );

    if (!requestedDirectoryPath) {
        return tasks;
    }

    const nextTasks = [...tasks];
    let directoryTask = nextTasks.find((task) => (
        isDesktopDirectoryTask(task)
        && cleanRelativeDirectoryPath(task.toolInput?.path) === requestedDirectoryPath
    ));

    if (!directoryTask) {
        const existingDirectoryTask = nextTasks.find(isDesktopDirectoryTask);

        if (existingDirectoryTask) {
            const directoryIndex = nextTasks.indexOf(existingDirectoryTask);
            directoryTask = {
                ...existingDirectoryTask,
                title: `Create Desktop directory ${requestedDirectoryPath}`,
                instruction: `Create a directory named ${requestedDirectoryPath} on the local Desktop.`,
                dependencies: [],
                assignedTool: 'fileManager',
                toolInput: {
                    action: 'createDesktopDirectory',
                    path: requestedDirectoryPath,
                },
            };
            nextTasks[directoryIndex] = directoryTask;
        } else {
            directoryTask = {
                nodeKey: getUniqueNodeKey(nextTasks, 'create_desktop_directory'),
                title: `Create Desktop directory ${requestedDirectoryPath}`,
                instruction: `Create a directory named ${requestedDirectoryPath} on the local Desktop.`,
                dependencies: [],
                assignedTool: 'fileManager',
                toolInput: {
                    action: 'createDesktopDirectory',
                    path: requestedDirectoryPath,
                },
            };
            nextTasks.unshift(directoryTask);
        }
    }

    const scaffoldCommand = 'npm create vite@latest . -- --template vue';
    let scaffoldTask = nextTasks.find(isVueScaffoldTask);

    if (scaffoldTask) {
        const scaffoldIndex = nextTasks.indexOf(scaffoldTask);
        scaffoldTask = {
            ...scaffoldTask,
            title: 'Scaffold the latest Vue 3 project',
            instruction: `Create the latest Vue project inside the Desktop directory ${requestedDirectoryPath}.`,
            dependencies: [...new Set([...(scaffoldTask.dependencies || []), directoryTask.nodeKey])]
                .filter((dependency) => dependency !== scaffoldTask.nodeKey),
            assignedTool: 'executeCommand',
            toolInput: {
                command: scaffoldCommand,
                cwd: requestedDirectoryPath,
                desktop: true,
            },
        };
        nextTasks[scaffoldIndex] = scaffoldTask;
    } else {
        scaffoldTask = {
            nodeKey: getUniqueNodeKey(nextTasks, 'scaffold_vue3_project'),
            title: 'Scaffold the latest Vue 3 project',
            instruction: `Create the latest Vue project inside the Desktop directory ${requestedDirectoryPath}.`,
            dependencies: [directoryTask.nodeKey],
            assignedTool: 'executeCommand',
            toolInput: {
                command: scaffoldCommand,
                cwd: requestedDirectoryPath,
                desktop: true,
            },
        };
        nextTasks.push(scaffoldTask);
    }

    let installTask = nextTasks.find((task) => task.nodeKey !== scaffoldTask.nodeKey && isVueInstallTask(task));

    if (installTask) {
        const installIndex = nextTasks.indexOf(installTask);
        installTask = {
            ...installTask,
            title: 'Install Vue 3 dependencies',
            instruction: `Install dependencies for the Vue project in the Desktop directory ${requestedDirectoryPath}.`,
            dependencies: [...new Set([...(installTask.dependencies || []), scaffoldTask.nodeKey])]
                .filter((dependency) => dependency !== installTask.nodeKey),
            assignedTool: 'executeCommand',
            toolInput: {
                command: 'npm install',
                cwd: requestedDirectoryPath,
                desktop: true,
            },
        };
        nextTasks[installIndex] = installTask;
    } else {
        installTask = {
            nodeKey: getUniqueNodeKey(nextTasks, 'install_vue3_dependencies'),
            title: 'Install Vue 3 dependencies',
            instruction: `Install dependencies for the Vue project in the Desktop directory ${requestedDirectoryPath}.`,
            dependencies: [scaffoldTask.nodeKey],
            assignedTool: 'executeCommand',
            toolInput: {
                command: 'npm install',
                cwd: requestedDirectoryPath,
                desktop: true,
            },
        };
        nextTasks.push(installTask);
    }

    return nextTasks;
};

const inferExistingDesktopProjectPath = (tasks, goalPrompt) => {
    const directPath = cleanRelativeDirectoryPath(
        inferDirectoryPath({title: '', instruction: ''}, {}, goalPrompt),
    );
    if (directPath) {
        return directPath;
    }

    const existingDirectory = tasks.find(isDesktopDirectoryTask);
    const existingDirectoryPath = cleanRelativeDirectoryPath(existingDirectory?.toolInput?.path);
    if (existingDirectoryPath) {
        return existingDirectoryPath;
    }

    const cwdTask = tasks.find((task) => {
        const cwd = task.toolInput?.cwd || task.toolInput?.workingDirectory;
        return typeof cwd === 'string' && cwd.trim();
    });
    const cwdPath = cleanRelativeDirectoryPath(cwdTask?.toolInput?.cwd || cwdTask?.toolInput?.workingDirectory);
    if (cwdPath) {
        return cwdPath;
    }

    const projectMatch = String(goalPrompt || '').match(
        /\b(?:in|inside|under|within)\s+(?:the\s+)?(?:desktop\s+)?(?:folder\s+)?["']?([A-Za-z0-9_-]+)["']?(?=\s|$|[.,!?])/i,
    );

    return cleanRelativeDirectoryPath(projectMatch?.[1]);
};

const isPiniaProjectSetupRequest = (goalPrompt) => {
    if (!LOCAL_DESKTOP_OUTPUT_ENABLED) {
        return false;
    }

    const text = String(goalPrompt || '');
    const mentionsPinia = /\bpin(?:ia|ai)\b/i.test(text);
    const mentionsStore = /\b(?:store|state\s+management)\b/i.test(text);
    const requestsChange = /\b(?:add|install|setup|set\s+up|configure|enable|create|use|integrate|modify)\b/i.test(text);
    const mentionsProject = /\b(?:desktop|production|project|app|application|folder|directory)\b/i.test(text);

    return mentionsPinia && mentionsStore && requestsChange && mentionsProject;
};

const isPiniaInstallTask = (task) => {
    const toolInput = task.toolInput || {};
    const text = `${task.title || ''} ${task.instruction || ''} ${toolInput.command || ''}`;

    return /\b(?:npm|pnpm|yarn|bun)\s+install\s+pin(?:ia|ai)\b/i.test(text)
        || (/\bpin(?:ia|ai)\b/i.test(text) && /\b(?:install|dependency|package)\b/i.test(text));
};

const isPiniaStoreTask = (task) => {
    const toolInput = task.toolInput || {};
    const taskPath = String(toolInput.path || '').replace(/\\/g, '/');
    const text = `${task.title || ''} ${task.instruction || ''} ${taskPath}`;

    return /(?:^|\/)stores?\/[^\s/]+\.(?:js|ts)$/i.test(taskPath)
        || (/\b(?:pin(?:ia|ai)|state\s+management)\b/i.test(text)
            && /\b(?:store|counter)\b/i.test(text));
};

const isPiniaMainTask = (task) => {
    const toolInput = task.toolInput || {};
    const taskPath = String(toolInput.path || '').replace(/\\/g, '/');
    const text = `${task.title || ''} ${task.instruction || ''} ${taskPath}`;

    return /(?:^|\/)main\.(?:js|ts)$/i.test(taskPath)
        && /\b(?:pin(?:ia|ai)|register|configure|setup|set\s+up|enable|use)\b/i.test(text);
};

const ensurePiniaDesktopProjectTasks = (tasks, goalPrompt) => {
    if (!isPiniaProjectSetupRequest(goalPrompt)) {
        return tasks;
    }

    const projectPath = inferExistingDesktopProjectPath(tasks, goalPrompt);
    if (!projectPath) {
        return tasks;
    }

    const nextTasks = [...tasks];
    let directoryTask = nextTasks.find((task) => (
        isDesktopDirectoryTask(task)
        && cleanRelativeDirectoryPath(task.toolInput?.path) === projectPath
    ));

    if (!directoryTask) {
        directoryTask = {
            nodeKey: getUniqueNodeKey(nextTasks, 'ensure_desktop_project_directory'),
            title: `Ensure Desktop directory ${projectPath}`,
            instruction: `Ensure the existing Vue project directory ${projectPath} is available on the local Desktop.`,
            dependencies: [],
            assignedTool: 'fileManager',
            toolInput: {
                action: 'createDesktopDirectory',
                path: projectPath,
            },
        };
        nextTasks.unshift(directoryTask);
    }

    const piniaInstallCommand = 'npm install pinia';
    let installTask = nextTasks.find(isPiniaInstallTask);
    if (installTask) {
        const installIndex = nextTasks.indexOf(installTask);
        installTask = {
            ...installTask,
            title: 'Install Pinia state management',
            instruction: `Install Pinia in the Vue project inside the Desktop directory ${projectPath}.`,
            dependencies: [...new Set([...(installTask.dependencies || []), directoryTask.nodeKey])]
                .filter((dependency) => dependency !== installTask.nodeKey),
            assignedTool: 'executeCommand',
            toolInput: {
                command: piniaInstallCommand,
                cwd: projectPath,
                desktop: true,
            },
        };
        nextTasks[installIndex] = installTask;
    } else {
        installTask = {
            nodeKey: getUniqueNodeKey(nextTasks, 'install_pinia'),
            title: 'Install Pinia state management',
            instruction: `Install Pinia in the Vue project inside the Desktop directory ${projectPath}.`,
            dependencies: [directoryTask.nodeKey],
            assignedTool: 'executeCommand',
            toolInput: {
                command: piniaInstallCommand,
                cwd: projectPath,
                desktop: true,
            },
        };
        nextTasks.push(installTask);
    }

    const storePath = `${projectPath}/src/stores/counter.js`;
    let storeTask = nextTasks.find(isPiniaStoreTask);
    if (storeTask) {
        const storeIndex = nextTasks.indexOf(storeTask);
        storeTask = {
            ...storeTask,
            title: 'Update the requested Pinia store',
            instruction: `Create the Pinia store requested by the user at ${storePath}.`,
            dependencies: [...new Set([...(storeTask.dependencies || []), installTask.nodeKey])]
                .filter((dependency) => dependency !== storeTask.nodeKey),
            assignedTool: 'fileManager',
            toolInput: {
                action: 'createDesktopFile',
                mode: 'update',
                path: storePath,
                content: typeof storeTask.toolInput?.content === 'string'
                    ? storeTask.toolInput.content
                    : '',
            },
        };
        nextTasks[storeIndex] = storeTask;
    } else {
        storeTask = {
            nodeKey: getUniqueNodeKey(nextTasks, 'create_pinia_store'),
            title: 'Create the requested Pinia store',
            instruction: `Create the Pinia store requested by the user at ${storePath}.`,
            dependencies: [installTask.nodeKey],
            assignedTool: 'fileManager',
            toolInput: {
                action: 'createDesktopFile',
                mode: 'update',
                path: storePath,
                content: '',
            },
        };
        nextTasks.push(storeTask);
    }

    const mainPath = `${projectPath}/src/main.js`;
    let mainTask = nextTasks.find(isPiniaMainTask)
        || nextTasks.find((task) => /(?:^|\/)main\.(?:js|ts)$/i.test(String(task.toolInput?.path || '').replace(/\\/g, '/')));
    if (mainTask) {
        const mainIndex = nextTasks.indexOf(mainTask);
        mainTask = {
            ...mainTask,
            title: 'Register Pinia in main.js',
            instruction: `Register Pinia in ${mainPath} so the Vue application can use the store.`,
            dependencies: [...new Set([...(mainTask.dependencies || []), storeTask.nodeKey])]
                .filter((dependency) => dependency !== mainTask.nodeKey),
            assignedTool: 'fileManager',
            toolInput: {
                action: 'createDesktopFile',
                mode: 'update',
                path: mainPath,
                content: typeof mainTask.toolInput?.content === 'string'
                    ? mainTask.toolInput.content
                    : '',
            },
        };
        nextTasks[mainIndex] = mainTask;
    } else {
        mainTask = {
            nodeKey: getUniqueNodeKey(nextTasks, 'register_pinia_main'),
            title: 'Register Pinia in main.js',
            instruction: `Register Pinia in ${mainPath} so the Vue application can use the store.`,
            dependencies: [storeTask.nodeKey],
            assignedTool: 'fileManager',
            toolInput: {
                action: 'createDesktopFile',
                mode: 'update',
                path: mainPath,
                content: '',
            },
        };
        nextTasks.push(mainTask);
    }

    const existingBuildTask = nextTasks.find((task) => /\b(?:npm|pnpm|yarn|bun)\s+run\s+build\b/i.test(String(task.toolInput?.command || '')));
    if (existingBuildTask) {
        const buildIndex = nextTasks.indexOf(existingBuildTask);
        nextTasks[buildIndex] = {
            ...existingBuildTask,
            title: 'Verify Vue and Pinia build',
            instruction: `Build the Vue project in ${projectPath} to verify the Pinia setup.`,
            dependencies: [...new Set([...(existingBuildTask.dependencies || []), mainTask.nodeKey])]
                .filter((dependency) => dependency !== existingBuildTask.nodeKey),
            assignedTool: 'executeCommand',
            toolInput: {
                command: 'npm run build',
                cwd: projectPath,
                desktop: true,
            },
        };
    } else {
        nextTasks.push({
            nodeKey: getUniqueNodeKey(nextTasks, 'verify_vue_pinia_build'),
            title: 'Verify Vue and Pinia build',
            instruction: `Build the Vue project in ${projectPath} to verify the Pinia setup.`,
            dependencies: [mainTask.nodeKey],
            assignedTool: 'executeCommand',
            toolInput: {
                command: 'npm run build',
                cwd: projectPath,
                desktop: true,
            },
        });
    }

    return nextTasks;
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
    const htmlSourceWithoutImages = isHtmlSourceRequest(goalPrompt)
        && !IMAGE_KEYWORD_PATTERN.test(String(goalPrompt || ''))
        && !IMAGE_URL_INTENT_PATTERN.test(String(goalPrompt || ''));

    if (htmlSourceWithoutImages) {
        const removedImageTaskKeys = new Set();
        const remainingTasks = tasks.filter((task) => {
            const isImageTask = task.assignedTool === IMAGE_GENERATOR_TOOL || isImageGenerationTask(task);
            if (isImageTask) {
                removedImageTaskKeys.add(task.nodeKey);
            }
            return !isImageTask;
        });

        tasks = remainingTasks.map((task) => ({
            ...task,
            dependencies: (task.dependencies || [])
                .filter((dependency) => !removedImageTaskKeys.has(dependency)),
        }));
    }

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
    const normalizedGoal = String(goalPrompt || '').replace(/\s+/g, ' ').trim();
    plan.summary = String(
        plan.summary
        || plan.description
        || (normalizedGoal ? `Plan for: ${normalizedGoal}` : 'Execution plan'),
    ).trim();

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

        // The executor rejects shell chaining. Expand planner output such as
        // `php --version && composer --version` into ordered command tasks.
        plan.tasks = normalizeChainedCommandTasks(plan.tasks);

        // A Desktop directory task establishes the destination for dependent file writes.
        // Without this pass, the directory goes to ~/Desktop while its files stay in workspaces/<runId>.
        plan.tasks = normalizeDesktopFileTasks(plan.tasks, goalPrompt);
        // A direct Desktop request must always produce both the directory and index.html task,
        // even when the LLM returns an incomplete plan containing only the directory step.
        plan.tasks = ensureDesktopIndexTask(plan.tasks, goalPrompt);
        // Website image URLs must be generated at runtime and resolved before index.html is written.
        plan.tasks = ensureHomepageImageTasks(plan.tasks, goalPrompt);
        // Homepage content must come from the planner model and the user's prompt, never a fixed template.
        plan.tasks = ensureHomepageContent(plan.tasks, goalPrompt);
        // General Desktop prompts may mention Java, JSON, Vue, Markdown, or other files.
        // Ensure every explicitly requested filename has a safe Desktop file task too.
        plan.tasks = ensureDesktopPromptFileTasks(plan.tasks, goalPrompt);
        // Vue/Vite project setup requires commands to run inside the requested Desktop folder.
        // The LLM plan may otherwise downgrade the request to a folder-only or file-only task.
        plan.tasks = ensureVueDesktopProjectTasks(plan.tasks, goalPrompt);
        // Pinia follow-up requests must execute inside the existing Desktop Vue project.
        // Normalize common misspellings such as "Pinai" to the real package and setup.
        plan.tasks = ensurePiniaDesktopProjectTasks(plan.tasks, goalPrompt);
        // Desktop asset discovery must use the constrained fileManager path, never a shell command.
        plan.tasks = normalizeDesktopAssetTasks(plan.tasks, goalPrompt);
        plan.tasks = normalizeImageTasks(plan.tasks, goalPrompt);
        plan.tasks = ensureRequestedHtmlTask(plan.tasks, goalPrompt);
        // Local development users should be able to open the generated project in Finder.
        plan.tasks = appendDesktopExportTask(plan.tasks, goalPrompt);
        // File-producing workflows without an explicit destination are downloaded locally by default.
        plan.tasks = appendDownloadsExportTask(plan.tasks, goalPrompt);

        if (isExplicitDesktopWriteRequest(goalPrompt)) {
            const directoryPath = cleanRelativeDirectoryPath(
                plan.tasks.find(isDesktopDirectoryTask)?.toolInput?.path
                    || inferDirectoryPath({title: '', instruction: ''}, {}, goalPrompt),
            );
            const requestedFiles = extractDesktopFileNames(goalPrompt);
            const homepageTopic = extractHomepageTopic(goalPrompt);

            if (directoryPath && requestedFiles.length) {
                plan.workflowTitle = homepageTopic && requestedFiles.some((fileName) => /^index\.html?$/i.test(fileName))
                    ? `Create ${homepageTopic} homepage in Desktop/${directoryPath}`
                    : `Create ${requestedFiles.join(', ')} in Desktop/${directoryPath}`;
                plan.summary = `Create ${requestedFiles.join(', ')} in the Desktop folder ${directoryPath} according to the user's request.`;
            } else if (directoryPath) {
                plan.workflowTitle = `Create Desktop folder ${directoryPath}`;
                plan.summary = `Create the Desktop folder ${directoryPath} according to the user's request.`;
            }
        }
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

const normalizeLocalDestination = (value) => {
    const raw = String(value || '').trim().replace(/\\/g, '/').replace(/^['"`]|['"`]$/g, '');
    const match = raw.match(/^(desktop|downloads?)\/(.+)$/i);
    if (!match) return null;

    const location = /^downloads?$/i.test(match[1]) ? 'Downloads' : 'Desktop';
    const relativePath = cleanRelativeDirectoryPath(match[2].replace(/[.,;!?]+$/, ''));
    if (!relativePath) return null;

    return {location, relativePath};
};

const buildPlanningGoalPrompt = (goalPrompt, localDestination) => {
    const destination = normalizeLocalDestination(localDestination);
    if (!destination) return goalPrompt;

    return `${goalPrompt}\n\n[Follow-up execution context: continue working in the existing local ${destination.location} folder ${destination.location}/${destination.relativePath}. Create or update the requested output there. Do not choose a different default destination.]`;
};

const planWorkflowRun = async ({
    runId,
    goalPrompt,
    localDestination = '',
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

    const planningGoalPrompt = buildPlanningGoalPrompt(goalPrompt, localDestination);
    const cacheKey = getCacheKey(planningGoalPrompt);
    let validatedPlan = null;

    if (planCache.has(cacheKey)) {
        console.log(`⚡ [Planner Cache Hit] Reusing validated DAG plan for goal: "${goalPrompt}"`);
        const cached = planCache.get(cacheKey);
        validatedPlan = normalizePlan(JSON.parse(JSON.stringify(cached)), {goalPrompt: planningGoalPrompt});
    }

    if (!validatedPlan) {
        const desktopInstruction = LOCAL_DESKTOP_OUTPUT_ENABLED
            ? `- Local file output is enabled for development. For a request to create a folder directly on the Mac Desktop, use fileManager with {"action":"createDesktopDirectory","path":"requested-folder"}. For a project setup inside that folder, first create the folder with fileManager, then use executeCommand with a relative cwd and desktop:true for the approved package-manager command. To list local assets, use fileManager with {"action":"listDesktopDirectory","path":"requested-folder","imagesOnly":true}; to export a completed project for Finder, use fileManager with {"action":"exportWorkspaceToDesktop","path":"requested-folder"}. For a local Downloads request, use fileManager with {"action":"exportWorkspaceToDownloads","path":"requested-folder"}. If a file-producing workflow does not specify a destination, add exportWorkspaceToDownloads as the final task so the result is available under ~/Downloads/kairo-workflow. Never use executeCommand to create a Desktop directory or to access arbitrary absolute local paths.`
            : '- Host Desktop output is disabled. Use fileManager action createDirectory with a relative path inside the workflow workspace; never target a host Desktop.';
        const systemPrompt = `
You are KAIRO, an autonomous AI workflow planner.
Decompose the user goal into a Directed Acyclic Graph (DAG) of executable subtasks.
Available Tools:
1. 'executeCommand' - Run one allowlisted workspace command at a time, such as cat, head, tail, grep, ls, pwd, find, wc, php, composer, npm, npx, node, and git. Never use shell chaining (&&, ||, or ;), pipes, redirects, subshells, or newlines. If multiple commands are needed, create separate dependent executeCommand tasks. Never use executeCommand or mkdir for directory creation; use fileManager instead.
2. 'fileManager' - Create, edit, read, list, delete files, create workspace directories, access a local Desktop directory, or export a completed workspace to the local Desktop or Downloads when explicitly enabled. Use {"action":"createDirectory","path":"relative/directory"} for workspace directories, {"action":"listDesktopDirectory","path":"requested-folder","imagesOnly":true} to list local Desktop image assets, {"action":"exportWorkspaceToDesktop","path":"requested-folder"} for explicit Desktop output, and {"action":"exportWorkspaceToDownloads","path":"requested-folder"} for local Downloads output.
3. 'webSearch' - Query DuckDuckGo; set toolInput.scrape=true when page HTML should be converted to Markdown.
4. 'databaseConnector' - Execute parameterized SQL with toolInput.sql and toolInput.params.
5. 'httpRequester' - Make HTTP/HTTPS API calls with toolInput.method, url, headers, params, and data.
6. 'imageGenerator' - Generate images, UI mockups, banners, or logos with toolInput.prompt, toolInput.fileName, toolInput.aspectRatio ('1:1', '16:9', '9:16', '4:3', '3:4'), and optional toolInput.outputMode ('file', 'url', or 'both').

Rules:
- Assign dependencies logically (for example, task_2 depends on ['task_1']).
- Never create circular dependencies.
- Every dependency must reference an existing nodeKey.
- Never use an absolute path or a path containing '..'. The executor enforces either the workspace boundary or the explicitly enabled local Desktop boundary.
- For regular directory creation, prefer the fileManager tool with action 'createDirectory'.
- Never assign executeCommand to a directory or folder creation task. For a local Desktop project setup, it is valid to run the project scaffolding and dependency-install commands with a relative Desktop cwd after the directory task succeeds.
- For requests to generate a visual image, logo, icon, banner, illustration, or artwork, assign imageGenerator. Do not answer with a textual design description or use fileManager to create an SVG unless the user explicitly requests source code.
- Use imageGenerator only for visual image, logo, icon, banner, illustration, or artwork generation. Never use it for HTML, JSON, CSS, JavaScript, metadata, project structure, file creation, or asset listing.
- For Pinia requests, use the correct package name 'pinia'. Install it with the package manager, create or update a store file with fileManager, and register createPinia() in the Vue entry file. Do not return manual shell heredocs or PowerShell write scripts as the workflow result.
- If the goal asks for image links, image URLs, remote images, external images, or CDN images, set imageGenerator toolInput.outputMode to 'url'. When creating HTML, use the returned imageUrl directly in img src, CSS background-image, hero slides, product cards, and category cards.
- For every requested HTML homepage, generate the complete document in fileManager toolInput.content from the exact user prompt. Do not use a fixed homepage template, fixed brand copy, fixed colors, fixed product names, or generic fallback content. Vary the layout, typography, content, color system, and components to match the requested subject and constraints.
- For every project setup request, derive the project name, framework, runtime, dependencies, files, commands, and source content from the exact user prompt. Do not add a fixed demo project, fixed file names, fixed starter copy, or generic fallback source. If the user did not request a file, do not invent one.
- Never replace model-generated source content with a generic fallback. If a requested source file has no generated content, preserve it as an empty file and keep the requested filename; do not fabricate unrelated code.
- A request containing a filename ending in .html or .htm is always a source-code request. Create that exact filename with fileManager and complete HTML content. Never rename it to .png, never use imageGenerator for it, and implement requested dark/light mode behavior with HTML, CSS, and JavaScript.
- Use imageGenerator only when the user explicitly requests an image, photo, logo, banner, illustration, artwork, or image URL. Words such as homepage, ecommerce, product, dark mode, or light mode alone do not request an image.
- If the HTML request asks for remote or generated images, use placeholders such as {{imageUrl:homepage_product_image_1}} in toolInput.content. Use one sequential placeholder per distinct image and create matching imageGenerator tasks; never hardcode stock image URLs.
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
        let currentPrompt = `Goal:\n"${planningGoalPrompt}"`;
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

                const parsed = validatePlan(rawResult.data, {goalPrompt: planningGoalPrompt});

                if (!parsed.success) {
                    lastPlannerError = new Error(parsed.error.message);
                    console.warn('⚠️ [Planner] Plan validation failed:', parsed.error.message);
                    currentPrompt = `Previous output had validation errors: ${parsed.error.message}. Generate a corrected plan for this goal:\n${planningGoalPrompt}`;
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
                currentPrompt = `An error occurred: ${error.message}. Generate valid DAG JSON for this goal:\n${planningGoalPrompt}`;
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
