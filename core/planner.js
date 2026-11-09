const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
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
    sshrequester: 'sshRequester',
    ssh_requester: 'sshRequester',
    ssh: 'sshRequester',
    remotecommand: 'sshRequester',
    remote_command: 'sshRequester',
    remoteshell: 'sshRequester',
    remote_shell: 'sshRequester',
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
const DESKTOP_FILES_ACTION = 'createDesktopFiles';
const FILE_WRITE_ACTIONS = new Set([
    'create',
    'write',
    'update',
    'append',
    'createfile',
    'createfiles',
    'writefile',
    'writefiles',
    'updatefile',
    'appendfile',
]);
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

    let cleaned = value
        .trim()
        .replace(/^['"`]|['"`]$/g, '')
        .replace(/^[~\\/]*desktops?[\\/]+/i, '')
        .replace(/(?:^|[\\/])desktops[\\/]/gi, '/');

    // Strip any accidental instruction sentences appended from context
    cleaned = cleaned
        .split(/\.\s*Create or update/i)[0]
        .split(/\s*\[Follow-up/i)[0]
        .split(/\.\s*Do not choose/i)[0]
        .trim()
        .replace(/[.,;!?]+$/, '');

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

    const desktopPathMatch = taskText.match(DESKTOP_PATH_PATTERN);
    if (desktopPathMatch) {
        return cleanRelativeDirectoryPath(desktopPathMatch[1].replace(/[.,;!?]+$/, ''));
    }

    const quotedName = taskText.match(
        /\b(?:directory|folder|project)\b[\s\S]{0,80}\b(?:named|called|name(?:\s+is)?(?:['’]s)?)\s*["']([^"']+)["']/i,
    );

    if (quotedName) {
        return cleanRelativeDirectoryPath(quotedName[1]);
    }

    const nameSuffix = taskText.match(
        /\b(?:directory|folder|project)\s+name(?:['’]s)?\s*[:=-]?\s*([A-Za-z0-9_-]+)/i,
    );

    if (nameSuffix) {
        return cleanRelativeDirectoryPath(nameSuffix[1]);
    }

    const desktopFolderName = taskText.match(
        /\b(?:desktop|downloads?)\b[\s\S]{0,40}\b(?:folder|directory|project)\b(?:\s+name(?:['’]s)?|\s+named|\s+called)?\s*[:=-]?\s*([A-Za-z0-9][A-Za-z0-9_-]*)/i,
    );

    if (desktopFolderName) {
        return cleanRelativeDirectoryPath(desktopFolderName[1]);
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

const isRenameRequest = (value) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();

    return /\b(?:rename|move|change)\b[\s\S]{0,100}\b(?:folder|directory|project)\b[\s\S]{0,80}\bfrom\b[\s\S]{1,80}\bto\b/i.test(text);
};

const isRemovalRequest = (value) => {
    const text = String(value || '');
    if (isRenameRequest(text)) {
        return false;
    }

    // A negated instruction such as "do not overwrite or delete anything"
    // describes protection requirements, not a deletion request.
    const hasNegatedDestructiveWord = /\b(?:do\s+not|don't|dont|never|not)\b[\s\S]{0,32}\b(?:remove|delete|erase|destroy|overwrite)\b/i.test(text);

    return !hasNegatedDestructiveWord
        && /\b(?:remove|delete|erase|destroy|clean\s*up|clear|strip)\b/i.test(text);
};

const getUserGoalText = (value) => String(value || '')
    .split(/\n\s*\[Follow-up execution context:/i, 1)[0]
    .replace(/\s+/g, ' ')
    .trim();

const INVALID_REMOVAL_TARGETS = new Set([
    'already',
    'it',
    'them',
    'this',
    'that',
    'folder',
    'directory',
    'project',
    'file',
    'files',
    'all',
    'now',
    'please',
    'again',
    'here',
    'there',
]);

const isStructureCleanupRequest = (value) => {
    // "Clean layered architecture" is an architecture quality adjective, not
    // a request to delete or reorganize an existing project structure.
    const text = String(value || '')
        .replace(/\bclean\s+(?:layered\s+)?architecture\b/gi, '');
    return /\b(?:cleanup|clean\s*up|reorganize|refactor|modify\s+structure|fix\s+structure|remove\s+redundant|remove\s+empty|delete\s+redundant|structure\s+project\s+to\s+clean|clean\s+structure)\b/i.test(text)
        || (/\b(?:remove|delete)\b/i.test(text) && /\b(?:still\s+have|src|redundant|empty|schema)\b/i.test(text));
};

const extractRemovalTarget = (value) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    const quotedMatch = text.match(
        /\b(?:file|folder|directory|project|path)\b[\s\S]{0,40}["'`]([^"'`]+)["'`]/i,
    );
    const plainMatch = text.match(
        /\b(?:file|folder|directory|project|path)\b\s+(?:(?:named|called|name(?:\s+is)?)\s+)?([A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)*)/i,
    );
    const directActionMatch = text.match(
        /\b(?:remove|delete|erase|destroy|clean\s*up|clear|strip)\s+(?:all\s+)?(?:the\s+)?(?:of\s+the\s+)?(?:files?\s+)?["'`]?([A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)*)["'`]?/i,
    );
    const candidate = quotedMatch?.[1] || plainMatch?.[1] || directActionMatch?.[1] || '';
    if (candidate && INVALID_REMOVAL_TARGETS.has(candidate.trim().toLowerCase())) {
        if (/\b(?:src|validation|schema)\b/i.test(text)) {
            return 'src';
        }
        return null;
    }

    const cleaned = cleanRelativeDirectoryPath(candidate);
    if (!cleaned) return null;
    if (cleaned === 'gitkeep' || cleaned.endsWith('/gitkeep')) {
        return cleaned.replace(/(^|[\\/])gitkeep$/, '$1.gitkeep');
    }
    return cleaned;
};

const extractRenamePaths = (value) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    const match = text.match(
        /\b(?:rename|move|change)\b[\s\S]{0,100}\b(?:folder|directory|project)\b[\s\S]{0,80}\bfrom\s+(["'`]?)([A-Za-z0-9][A-Za-z0-9 _./-]*?)\1\s+to\s+(["'`]?)([A-Za-z0-9][A-Za-z0-9 _./-]*?)\3(?=\s+(?:on|in|inside|while|and|preserve|with|then)\b|[.,;!?]|$)/i,
    );

    if (!match) {
        return null;
    }

    const sourcePath = cleanRelativeDirectoryPath(match[2].trim());
    const targetPath = cleanRelativeDirectoryPath(match[4].trim());
    if (!sourcePath || !targetPath || sourcePath === targetPath) {
        return null;
    }

    return {sourcePath, targetPath};
};

const normalizeRenamePlan = (tasks, goalPrompt) => {
    const userGoal = getUserGoalText(goalPrompt);
    if (!LOCAL_DESKTOP_OUTPUT_ENABLED || !isRenameRequest(userGoal)) {
        return tasks;
    }

    const renamePaths = extractRenamePaths(userGoal);
    if (!renamePaths) {
        return tasks;
    }

    return [{
        nodeKey: 'rename_requested_desktop_folder',
        title: `Rename Desktop/${renamePaths.sourcePath} to Desktop/${renamePaths.targetPath}`,
        instruction: `Rename the existing local Desktop folder ${renamePaths.sourcePath} to ${renamePaths.targetPath}. Preserve all files and contents. Do not delete or overwrite any unrelated path.`,
        dependencies: [],
        assignedTool: 'fileManager',
        toolInput: {
            action: 'renameDesktopPath',
            path: renamePaths.sourcePath,
            destination: renamePaths.targetPath,
            kind: 'directory',
        },
    }];
};

const normalizeStructureCleanupTasks = (tasks, goalPrompt, localDestination = '') => {
    if (!isStructureCleanupRequest(goalPrompt)) {
        return tasks;
    }

    let targetProject = cleanRelativeDirectoryPath(localDestination)
        || cleanRelativeDirectoryPath(inferDirectoryPath({title: '', instruction: ''}, {}, goalPrompt));

    if (targetProject === 'Api-Productions' || !targetProject) {
        if (/Sample-RESTful-API-/i.test(goalPrompt)) {
            targetProject = 'Api-Productions/Sample-RESTful-API-';
        }
    }

    let filteredTasks = tasks.filter((task) => {
        const action = String(task.toolInput?.action || '').toLowerCase();
        return action !== 'exportworkspacetodownloads' && action !== 'exportworkspacetodesktop';
    });

    const hasRemovalTask = filteredTasks.some((task) => {
        const action = String(task.toolInput?.action || '').toLowerCase();
        return action === 'deletedesktoppath';
    });

    if (!hasRemovalTask && targetProject) {
        const projectRoot = targetProject.replace(/^[~\/]*desktops?[\/]+/i, '');
        const srcPath = `${projectRoot}/src`;
        const nodeKey = 'cleanup_redundant_src';

        filteredTasks.push({
            nodeKey,
            title: `Remove redundant empty src directory from ${projectRoot}`,
            instruction: `Delete the redundant empty 'src' directory (and nested folders like 'src/validation/schema') from ${projectRoot} to keep the project structure clean and aligned with root-level MVC layout.`,
            dependencies: filteredTasks.map((t) => t.nodeKey),
            assignedTool: 'fileManager',
            toolInput: {
                action: 'deleteDesktopPath',
                path: srcPath,
                kind: 'directory',
                ignoreMissing: true,
            },
        });
    }

    return filteredTasks;
};

const normalizeRemovalPlan = (tasks, goalPrompt, localDestination = '') => {
    const userGoal = getUserGoalText(goalPrompt);

    if (!isRemovalRequest(userGoal)) {
        return tasks;
    }

    const targetPath = extractRemovalTarget(userGoal);
    if (!targetPath) {
        return tasks;
    }

    const isGitkeep = targetPath === '.gitkeep' || targetPath.endsWith('/.gitkeep');
    const explicitlyFolder = !isGitkeep && /\b(?:folder|directory|project)\b/i.test(userGoal);
    const targetLooksLikeFile = isGitkeep || /(?:^|[\\/])\.?[^\\/]+\.[A-Za-z0-9]{1,16}$/.test(targetPath);
    const targetIsFile = !explicitlyFolder && (/\bfile\b/i.test(userGoal) || targetLooksLikeFile);
    const action = LOCAL_DESKTOP_OUTPUT_ENABLED ? 'deleteDesktopPath' : 'delete';
    const location = LOCAL_DESKTOP_OUTPUT_ENABLED ? 'Desktop' : 'workflow workspace';
    const destination = LOCAL_DESKTOP_OUTPUT_ENABLED ? normalizeLocalDestination(localDestination) : null;
    let destinationScope = destination?.location === 'Desktop' ? destination.relativePath : '';

    if (!destinationScope && LOCAL_DESKTOP_OUTPUT_ENABLED) {
        const folderMatch = userGoal.match(/\b(?:in|inside|from|within)\s+(?:folder|project|directory\s+)?["'`]?([A-Za-z0-9_-]+(?:[\\/][A-Za-z0-9_-]+)*)["'`]?/i);
        if (folderMatch) {
            destinationScope = folderMatch[1];
        }
    }

    const hasNestedTarget = targetPath.includes('/') || targetPath.includes('\\');
    const scopedTargetPath = destinationScope && !hasNestedTarget
        ? `${destinationScope}/${targetPath}`
        : targetPath;

    return [{
        nodeKey: 'remove_requested_target',
        title: `Remove ${isGitkeep ? 'all .gitkeep files' : (targetIsFile ? 'file' : 'folder')} ${location}/${scopedTargetPath}`,
        instruction: `Remove the requested ${isGitkeep ? '.gitkeep files' : (targetIsFile ? 'file' : 'folder')} ${scopedTargetPath} from the local ${location}. Do not create or modify any other files.`,
        dependencies: [],
        assignedTool: 'fileManager',
        toolInput: {
            action,
            path: scopedTargetPath,
            ...(targetIsFile ? {kind: 'file'} : {kind: 'directory'}),
            ...(destinationScope ? {searchPath: destinationScope} : {}),
            ...(isGitkeep || /\ball\b/i.test(userGoal) ? {all: true} : {}),
        },
    }];
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

// Desktop project paths must be rooted at the folder explicitly named by the
// user. LLM output can contain an accidental prefix such as
// `src/views/Rent-Room`, or repeat the project root more than once. Keeping
// this normalization in one place prevents later passes from turning that
// mistake into `Rent-Room/src/views/Rent-Room/...`.
const canonicalizeProjectPath = (value, projectRootPath) => {
    const cleanPath = cleanRelativeFilePath(value);
    const cleanRoot = cleanRelativeDirectoryPath(projectRootPath);
    if (!cleanPath || !cleanRoot) {
        return null;
    }

    const pathSegments = cleanPath.split('/').filter(Boolean);
    const rootSegments = cleanRoot.split('/').filter(Boolean);
    if (!pathSegments.length || !rootSegments.length) {
        return null;
    }

    const normalizedPathSegments = pathSegments.map((segment) => segment.toLowerCase());
    const normalizedRootSegments = rootSegments.map((segment) => segment.toLowerCase());
    let rootIndex = -1;

    for (let index = 0; index <= pathSegments.length - rootSegments.length; index += 1) {
        const matches = normalizedRootSegments.every((segment, offset) => (
            normalizedPathSegments[index + offset] === segment
        ));
        if (matches) {
            rootIndex = index;
        }
    }

    if (rootIndex >= 0) {
        return [
            ...rootSegments,
            ...pathSegments.slice(rootIndex + rootSegments.length),
        ].join('/');
    }

    return [cleanRoot, cleanPath].join('/');
};

const inferNodeProjectSourceDirectory = (task, filePath) => {
    const rawFileName = path.basename(String(filePath || ''));
    const text = `${task?.title || ''} ${task?.instruction || ''} ${filePath || ''}`.toLowerCase();

    // Derive the layer from the file name instead of maintaining a fixed
    // feature list. This handles names such as AuthController.js,
    // room_service.js, and payment-routes.js without assuming which modules
    // the user wants to build.
    const fileStem = rawFileName.replace(/\.[^.]+$/, '');
    const camelCaseSuffixMatch = fileStem.match(/(?:^|[a-z0-9])([A-Z][A-Za-z0-9]+)$/);
    const separatorSuffixMatch = fileStem.match(/[_-]([a-z][a-z0-9]+)$/i);
    const taskLayerMatch = text.match(/\b([a-z][a-z0-9_-]*)\s+(?:layer|directory|folder)\b/i);
    const candidate = camelCaseSuffixMatch?.[1] || separatorSuffixMatch?.[1] || taskLayerMatch?.[1] || '';
    const normalizedCandidate = candidate.replace(/[-_]+/g, ' ').trim();

    if (normalizedCandidate && /[a-z]/i.test(normalizedCandidate)) {
        const singular = normalizedCandidate.replace(/\s+/g, '').toLowerCase();
        const directoryName = singular.endsWith('s')
            ? singular
            : singular.endsWith('y')
                ? `${singular.slice(0, -1)}ies`
                : `${singular}s`;
        return directoryName;
    }

    return null;
};

const normalizeNodeProjectFilePath = (filePath, task, projectRootPath) => {
    const canonicalPath = canonicalizeProjectPath(filePath, projectRootPath);
    if (!canonicalPath) {
        return null;
    }
    return canonicalPath;
};

const inferProjectSourceDirectories = (tasks, projectRootPath) => {
    const sourceDirectories = new Set();
    const rootPrefix = `${cleanRelativeDirectoryPath(projectRootPath)}/`;

    for (const task of tasks) {
        const toolInput = task.toolInput || {};
        const fileEntries = Array.isArray(toolInput.files)
            ? toolInput.files
            : toolInput.files && typeof toolInput.files === 'object'
                ? Object.entries(toolInput.files).map(([filePath]) => ({path: filePath}))
                : [{path: toolInput.path}];

        for (const entry of fileEntries) {
            const canonicalPath = canonicalizeProjectPath(entry?.path, projectRootPath);
            if (!canonicalPath || !canonicalPath.startsWith(rootPrefix)) {
                continue;
            }

            const relativePath = canonicalPath.slice(rootPrefix.length);
            const inferredSourceDirectory = inferNodeProjectSourceDirectory(task, relativePath);
            const directoryName = inferredSourceDirectory?.split('/').pop();
            if (directoryName) {
                sourceDirectories.add(directoryName.toLowerCase());
            }
        }
    }

    return sourceDirectories;
};

const normalizeNodeProjectDirectoryPath = (directoryPath, projectRootPath, sourceDirectories = new Set()) => {
    const canonicalPath = canonicalizeProjectPath(directoryPath, projectRootPath);
    if (!canonicalPath) {
        return null;
    }
    return canonicalPath;
};

const deduplicateProjectDirectoryTasks = (tasks, isDirectoryAction) => {
    const canonicalDirectoryTasks = new Map();
    const redirectedDependencies = new Map();
    const keptTasks = [];

    for (const task of tasks) {
        const action = String(task.toolInput?.action || '').trim().toLowerCase();
        if (!isDirectoryAction(action)) {
            keptTasks.push(task);
            continue;
        }

        const directoryPath = cleanRelativeDirectoryPath(task.toolInput?.path);
        if (!directoryPath) {
            keptTasks.push(task);
            continue;
        }

        const existingTask = canonicalDirectoryTasks.get(directoryPath);
        if (existingTask) {
            redirectedDependencies.set(task.nodeKey, existingTask.nodeKey);
            continue;
        }

        canonicalDirectoryTasks.set(directoryPath, task);
        keptTasks.push(task);
    }

    if (!redirectedDependencies.size) {
        return keptTasks;
    }

    const resolveDependency = (dependency) => {
        let resolved = dependency;
        const visited = new Set();
        while (redirectedDependencies.has(resolved) && !visited.has(resolved)) {
            visited.add(resolved);
            resolved = redirectedDependencies.get(resolved);
        }
        return resolved;
    };

    return keptTasks.map((task) => ({
        ...task,
        dependencies: [...new Set((task.dependencies || [])
            .map(resolveDependency)
            .filter((dependency) => dependency !== task.nodeKey))],
    }));
};

const cleanDesktopRelativePath = (value) => {
    if (typeof value !== 'string') {
        return null;
    }

    let cleaned = value
        .trim()
        .replace(/^['"`]|['"`]$/g, '')
        .split(/\.\s*Create or update/i)[0]
        .split(/\s*\[Follow-up/i)[0]
        .split(/\.\s*Do not choose/i)[0]
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
    const action = String(toolInput.action || '').trim().toLowerCase();
    if (action === 'exportworkspacetodesktop'
        || action === 'export_workspace_to_desktop'
        || action === 'exportworkspacetodownloads'
        || action === 'export_workspace_to_downloads') {
        return false;
    }

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
        const tool = String(task.assignedTool || '').trim().toLowerCase();
        const action = String(task.toolInput?.action || '').trim().toLowerCase();
        if (action === 'createdesktopfile' || action === 'create_desktop_file'
            || action === 'exportworkspacetodesktop' || action === 'export_workspace_to_desktop') {
            return true;
        }

        if (tool !== 'filemanager' && tool !== 'file_manager') {
            return false;
        }

        const files = Array.isArray(task.toolInput?.files) ? task.toolInput.files : [];
        return files.some((file) => /^(?:desktop[\\/]|~[\\/]?desktop[\\/])/i.test(String(file?.path || file?.fileName || '').trim()));
    });

    return !hasExistingDesktopFileOutput;
};

const normalizeLocalExportTasks = (tasks, goalPrompt) => {
    if (!isExplicitDesktopWriteRequest(goalPrompt)) {
        return tasks;
    }

    const keepsDownloads = isDownloadsOutputRequest(goalPrompt);
    const requestedDesktopPath = cleanRelativeDirectoryPath(
        inferDirectoryPath({title: '', instruction: ''}, {}, goalPrompt),
    );
    const hasDirectDesktopFileOutput = tasks.some((task) => {
        const tool = String(task.assignedTool || '').trim().toLowerCase();
        const action = String(task.toolInput?.action || '').trim().toLowerCase();
        if (action === 'createdesktopfile' || action === 'create_desktop_file') {
            return true;
        }

        if (tool !== 'filemanager' && tool !== 'file_manager') {
            return false;
        }

        const filePath = String(task.toolInput?.path || '').trim();
        const files = Array.isArray(task.toolInput?.files) ? task.toolInput.files : [];
        return /^(?:desktop[\\/]|~[\\/]?desktop[\\/])/i.test(filePath)
            || files.some((file) => /^(?:desktop[\\/]|~[\\/]?desktop[\\/])/i.test(String(file?.path || file?.fileName || '').trim()));
    });

    const removedKeys = new Set();
    const filteredTasks = tasks.filter((task) => {
        const action = String(task.toolInput?.action || '').trim().toLowerCase();
        const isDownloadsExport = action === 'exportworkspacetodownloads'
            || action === 'export_workspace_to_downloads';
        const isDesktopExport = action === 'exportworkspacetodesktop'
            || action === 'export_workspace_to_desktop';

        if (isDownloadsExport && !keepsDownloads) {
            removedKeys.add(task.nodeKey);
            return false;
        }

        if (isDesktopExport && hasDirectDesktopFileOutput) {
            removedKeys.add(task.nodeKey);
            return false;
        }

        return true;
    });

    if (!removedKeys.size && !requestedDesktopPath) {
        return tasks;
    }

    return filteredTasks.map((task) => {
        const action = String(task.toolInput?.action || '').trim().toLowerCase();
        const isDesktopExport = action === 'exportworkspacetodesktop'
            || action === 'export_workspace_to_desktop';

        if (isDesktopExport && requestedDesktopPath) {
            return {
                ...task,
                title: `Export generated output to Desktop/${requestedDesktopPath}`,
                instruction: `Copy the completed workflow output to the local Desktop folder ${requestedDesktopPath}, excluding generated node_modules dependencies.`,
                dependencies: (task.dependencies || []).filter((dependency) => !removedKeys.has(dependency)),
                toolInput: {
                    ...task.toolInput,
                    action: 'exportWorkspaceToDesktop',
                    path: requestedDesktopPath,
                },
            };
        }

        return {
            ...task,
            dependencies: (task.dependencies || []).filter((dependency) => !removedKeys.has(dependency)),
        };
    });
};

const appendDesktopExportTask = (tasks, goalPrompt, localDestination = '') => {
    // Follow-up changes to an existing local Desktop project are written
    // directly into that project. Exporting the temporary workflow workspace
    // afterward can copy an incomplete tree over the real project and make a
    // successful directory task appear empty in Finder.
    if (isVueProjectSetupRequest(goalPrompt)
        || isNodeProjectSetupRequest(goalPrompt)
        || isExplicitExistingProjectUpdateRequest(goalPrompt)) {
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

    const dest = normalizeLocalDestination(localDestination);
    const exportPath = dest?.relativePath
        || cleanRelativeDirectoryPath(
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
        || isNodeProjectSetupRequest(goalPrompt)
        || isStructureCleanupRequest(goalPrompt)
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

    // Prefer the directory explicitly named in the user prompt over a path
    // supplied by the model. The model path may be malformed or may point to
    // a nested view folder instead of the requested project root.
    const inferredDirectoryPath = inferDirectoryPath({title: '', instruction: ''}, {}, goalPrompt)
        || desktopDirectoryTasks[0]?.toolInput?.path;

    return tasks.map((task) => {
        if (task.assignedTool !== 'fileManager') {
            return task;
        }

        const action = String(task.toolInput?.action || '').trim().toLowerCase();
        const isDesktopFileWriteAction = action === 'createdesktopfile'
            || action === 'create_desktop_file'
            || action === 'createdesktopfiles'
            || action === 'create_desktop_files';
        if (!FILE_WRITE_ACTIONS.has(action) && !isDesktopFileWriteAction) {
            return task;
        }

        const dependsOnDesktopDirectory = task.dependencies.some((dependency) => {
            return desktopDirectoryTasks.some((directoryTask) => directoryTask.nodeKey === dependency);
        });

        if (!dependsOnDesktopDirectory && !desktopGoal) {
            return task;
        }

        if (action === 'createfiles' || action === 'writefiles') {
            const fileEntries = Array.isArray(task.toolInput.files)
                ? task.toolInput.files
                : task.toolInput.files && typeof task.toolInput.files === 'object'
                    ? Object.entries(task.toolInput.files).map(([filePath, content]) => ({path: filePath, content}))
                    : [];
            const directoryPath = cleanRelativeDirectoryPath(inferredDirectoryPath);
            const desktopFiles = fileEntries
                .map((entry) => {
                    const filePath = cleanRelativeFilePath(entry?.path || entry?.fileName);
                    if (!filePath) return null;

                    const desktopPath = directoryPath
                        ? canonicalizeProjectPath(filePath, directoryPath)
                        : filePath;

                    return {
                        ...entry,
                        path: desktopPath,
                    };
                })
                .filter(Boolean);

            if (!desktopFiles.length) {
                return task;
            }

            return {
                ...task,
                toolInput: {
                    ...task.toolInput,
                    action: DESKTOP_FILES_ACTION,
                    files: desktopFiles,
                },
            };
        }

        const filePath = cleanRelativeFilePath(task.toolInput.path);
        if (!filePath) {
            return task;
        }

        const directoryPath = cleanRelativeDirectoryPath(inferredDirectoryPath);
        const desktopPath = directoryPath
            ? canonicalizeProjectPath(filePath, directoryPath)
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
        .filter((candidate) => !/^(?:node|express|vue|react|next)\.js$/i.test(candidate))
        .filter((candidate, index, all) => all.indexOf(candidate) === index);
};

const extractProjectTreeLayout = (goalPrompt) => {
    const directories = new Set();
    const files = new Set();
    const directoryStack = [];
    const treeEntryPattern = /^((?:(?:│|\|)\s{3}| {4})*)(?:├──|└──|\|--)\s*([^\s#]+)(?:\s+#.*)?$/;

    for (const line of String(goalPrompt || '').split(/\r?\n/)) {
        const match = line.match(treeEntryPattern);
        if (!match) {
            continue;
        }

        const depth = (match[1].match(/(?:│|\|)\s{3}| {4}/g) || []).length;
        const rawName = match[2].replace(/[),;]+$/, '');
        const isDirectory = /[\\/]$/.test(rawName);
        const entryName = rawName.replace(/[\\/]+$/, '');

        if (!entryName || entryName === '.' || entryName === '..') {
            continue;
        }

        directoryStack.length = depth;
        const relativePath = cleanRelativeFilePath([...directoryStack, entryName].join('/'));
        if (!relativePath) {
            continue;
        }

        if (isDirectory) {
            directories.add(relativePath);
            directoryStack[depth] = entryName;
        } else {
            files.add(relativePath);
        }
    }

    // package.json and similar root files are often mentioned in prose rather
    // than repeated in the tree. Add those explicit names without duplicating
    // files already found at another tree depth.
    const treeFileNames = new Set(
        [...files].map((filePath) => path.basename(filePath).toLowerCase()),
    );
    for (const fileName of extractDesktopFileNames(goalPrompt)) {
        if (!fileName.includes('/') && !treeFileNames.has(fileName.toLowerCase())) {
            files.add(fileName);
        }
    }

    // A file path implies every parent directory even if the prompt omitted an
    // intermediate `foo/` line from its tree.
    for (const filePath of files) {
        const segments = filePath.split('/');
        for (let index = 1; index < segments.length; index += 1) {
            directories.add(segments.slice(0, index).join('/'));
        }
    }

    return {
        directories: [...directories],
        files: [...files],
    };
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

    // An explicit project tree is handled after Node project paths have been
    // canonicalized. Creating basename-only files here would lose paths such
    // as src/controllers/authController.js.
    if (extractProjectTreeLayout(goalPrompt).files.length > 0) {
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

    const nextTasks = [...tasks];
    let directoryTask = directoryPath
        ? nextTasks.find((task) => (
            isDesktopDirectoryTask(task)
            && cleanRelativeDirectoryPath(task.toolInput?.path) === directoryPath
        ))
        : null;

    if (directoryPath && !directoryTask) {
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
            const desktopPath = directoryPath
                ? (requestedPath === directoryPath || requestedPath.startsWith(`${directoryPath}/`)
                    ? requestedPath
                    : `${directoryPath}/${requestedPath}`)
                : requestedPath;
            const fileEntry = Array.isArray(existingTask.toolInput?.files)
                ? existingTask.toolInput.files.find((entry) => (
                    path.basename(String(entry?.path || entry?.fileName || '').replace(/\\/g, '/')).toLowerCase()
                    === fileName.toLowerCase()
                ))
                : null;
            const existingContent = typeof existingTask.toolInput?.content === 'string'
                ? existingTask.toolInput.content.trim()
                : typeof fileEntry?.content === 'string' ? fileEntry.content : '';
            const isHomepageFile = /^index\.html?$/i.test(fileName) && isIndexHtmlRequest(goalPrompt);

            const taskIndex = nextTasks.indexOf(existingTask);
            nextTasks[taskIndex] = {
                ...existingTask,
                title: isHomepageFile
                    ? `Create ${directoryPath ? `${directoryPath}/` : ''}${fileName} homepage`
                    : `Create Desktop file ${fileName}`,
                instruction: isHomepageFile
                    ? `Create a homepage for ${extractHomepageTopic(goalPrompt) || 'the requested subject'} in ${directoryPath ? `${directoryPath}/` : ''}${fileName}.`
                    : directoryPath
                        ? `Create ${fileName} inside the Desktop directory ${directoryPath}.`
                        : `Create ${fileName} directly on the local Desktop.`,
                assignedTool: 'fileManager',
                dependencies: [...new Set([
                    ...(existingTask.dependencies || []),
                    ...(directoryTask ? [directoryTask.nodeKey] : []),
                ])],
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
            instruction: directoryPath
                ? `Create ${fileName} inside the Desktop directory ${directoryPath}.`
                : `Create ${fileName} directly on the local Desktop.`,
            dependencies: directoryTask ? [directoryTask.nodeKey] : [],
            assignedTool: 'fileManager',
            toolInput: {
                action: DESKTOP_FILE_ACTION,
                mode: 'create',
                path: directoryPath ? `${directoryPath}/${fileName}` : fileName,
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

    if (isExplicitExistingProjectUpdateRequest(goalPrompt)) {
        return false;
    }

    const text = String(goalPrompt || '');
    const mentionsVue = /\bvue(?:\.js)?\b|\bvue\s*3\b|\bvue3\b/i.test(text);
    const mentionsProject = /\b(?:project|app|application|starter|template)\b/i.test(text);
    const requestsSetup = /\b(?:setup|set\s+up|scaffold|initialize|init|create|generate|start|build)\b/i.test(text);

    return mentionsVue
        && mentionsProject
        && requestsSetup
        && /\bdesktop\b/i.test(text);
};

const isNodeProjectSetupRequest = (goalPrompt) => {
    if (!LOCAL_DESKTOP_OUTPUT_ENABLED) {
        return false;
    }

    if (isExplicitExistingProjectUpdateRequest(goalPrompt)) {
        return false;
    }

    const text = String(goalPrompt || '');
    const mentionsNode = /\bnode(?:\.js|\s*js)?\b/i.test(text);
    const mentionsProject = /\b(?:project|app|application|starter|template)\b/i.test(text);
    const requestsSetup = /\b(?:setup|set\s+up|scaffold|initialize|init|create|generate|start)\b/i.test(text);
    const mentionsArchitecture = /\b(?:mvc|model[-\s]*view[-\s]*controller|service\s+pattern|service\s+layer|controller|model|route|routes)\b/i.test(text);
    const mentionsDesktop = /\bdesk(?:top|spto|stop)\b/i.test(text);

    return mentionsDesktop
        && mentionsProject
        && (mentionsNode || mentionsArchitecture)
        && (requestsSetup || mentionsArchitecture);
};

const isIdempotentDesktopSetupRequest = (goalPrompt) => {
    if (!LOCAL_DESKTOP_OUTPUT_ENABLED) {
        return false;
    }

    const text = String(goalPrompt || '');
    const mentionsDesktop = /\bdesk(?:top|spto|stop)\b/i.test(text);
    const requestsSetup = /\b(?:setup|set\s+up|scaffold|initialize|init|create|generate|build|install)\b/i.test(text);
    const mentionsProject = /\b(?:project|app|application|system|service|api|backend|frontend|website)\b/i.test(text);
    const explicitlyChangesExistingFiles = /\b(?:overwrite|replace|update|modify|edit|rewrite)\b/i.test(text);
    const explicitlyPreservesExistingFiles = /\b(?:do\s+not|don't|dont|never|without)\b[\s\S]{0,32}\b(?:overwrite|replace|update|modify|edit|rewrite)\b/i.test(text);

    return mentionsDesktop
        && requestsSetup
        && mentionsProject
        && (!explicitlyChangesExistingFiles || explicitlyPreservesExistingFiles);
};

const normalizeIdempotentDesktopSetupTasks = (tasks, goalPrompt) => {
    if (!isIdempotentDesktopSetupRequest(goalPrompt)) {
        return tasks;
    }

    return tasks.map((task) => {
        const tool = String(task.assignedTool || '').trim().toLowerCase();
        const action = String(task.toolInput?.action || '').trim().toLowerCase();
        const isFileManager = tool === 'filemanager' || tool === 'file_manager';
        const isCreateFileAction = new Set([
            'create',
            'createfile',
            'create_file',
            'createfiles',
            'create_files',
            'createdesktopfile',
            'create_desktop_file',
            'createdesktopfiles',
            'create_desktop_files',
        ]).has(action);

        if (!isFileManager || !isCreateFileAction) {
            return task;
        }

        const mode = String(task.toolInput?.mode || '').trim().toLowerCase();
        if (task.toolInput?.overwrite === true || ['write', 'update', 'append'].includes(mode)) {
            return task;
        }

        return {
            ...task,
            toolInput: {
                ...task.toolInput,
                ifExists: 'skip',
            },
        };
    });
};

const isExplicitExistingProjectUpdateRequest = (goalPrompt) => {
    const text = String(goalPrompt || '');
    const userGoal = getUserGoalText(text);
    const hasFollowUpContext = /\[Follow-up execution context:\s*continue working in the existing local/i.test(text);
    const hasFollowUpIntent = /\b(?:add|install|configure|fix|update|modify|edit|extend|refactor|build|create|generate|scaffold)\b/i.test(userGoal);
    if (hasFollowUpContext && hasFollowUpIntent) {
        return true;
    }

    const hasUpdateIntent = /\b(?:update|modify|edit|rewrite|refactor|replace|overwrite)\b/i.test(text);
    const targetsExistingWork = /\b(?:existing|current|already[-\s]?created|present)\b[\s\S]{0,80}\b(?:project|app(?:lication)?|file|component|codebase|source)\b/i.test(text)
        || /\b(?:project|app(?:lication)?|file|component|codebase|source)\b[\s\S]{0,80}\b(?:existing|current|already[-\s]?created|present)\b/i.test(text);
    const hasProjectTarget = /\b(?:project|app(?:lication)?|file|files|component|components|codebase|source)\b/i.test(text);
    const negatesUpdate = /\b(?:do\s+not|don't|dont|never|without)\b[\s\S]{0,32}\b(?:overwrite|replace|update|modify|edit|rewrite)\b/i.test(text);

    return hasUpdateIntent
        && hasProjectTarget
        && (targetsExistingWork || /\b(?:update|modify|edit|rewrite|refactor)\b[\s\S]{0,60}\b(?:project|app(?:lication)?|file|component|codebase|source)\b/i.test(text))
        && !negatesUpdate;
};

const hasGeneratedFileContent = (value) => {
    if (typeof value === 'string') {
        return value.trim().length > 0;
    }

    return value !== undefined && value !== null;
};

const normalizeExistingProjectUpdateTasks = (tasks, goalPrompt) => {
    if (!isExplicitExistingProjectUpdateRequest(goalPrompt)) {
        return tasks;
    }

    return tasks.map((task) => {
        const tool = String(task.assignedTool || '').trim().toLowerCase();
        const action = String(task.toolInput?.action || '').trim().toLowerCase();

        if (tool !== 'filemanager' && tool !== 'file_manager') {
            return task;
        }

        if (String(task.toolInput?.ifExists || '').trim().toLowerCase() === 'skip') {
            return task;
        }

        if (action === 'createfiles' || action === 'create_files'
            || action === 'createdesktopfiles' || action === 'create_desktop_files') {
            const files = Array.isArray(task.toolInput?.files)
                ? task.toolInput.files
                : task.toolInput?.files && typeof task.toolInput.files === 'object'
                    ? Object.entries(task.toolInput.files).map(([filePath, content]) => ({path: filePath, content}))
                    : [];

            if (!files.length) {
                return task;
            }

            return {
                ...task,
                toolInput: {
                    ...task.toolInput,
                    files: files.map((file) => ({
                        ...file,
                        mode: hasGeneratedFileContent(file?.content) ? 'update' : 'skip',
                    })),
                },
            };
        }

        if (action === 'createdesktopfile' || action === 'create_desktop_file') {
            if (!hasGeneratedFileContent(task.toolInput?.content)) {
                return {
                    ...task,
                    toolInput: {
                        ...task.toolInput,
                        ifExists: 'skip',
                    },
                };
            }

            return {
                ...task,
                toolInput: {
                    ...task.toolInput,
                    mode: 'update',
                },
            };
        }

        if (['create', 'createfile', 'create_file'].includes(action)) {
            if (!hasGeneratedFileContent(task.toolInput?.content)) {
                return {
                    ...task,
                    toolInput: {
                        ...task.toolInput,
                        ifExists: 'skip',
                    },
                };
            }

            return {
                ...task,
                toolInput: {
                    ...task.toolInput,
                    action: 'update',
                },
            };
        }

        return task;
    });
};

const ensureRequestedArchitectureDirectories = (tasks, goalPrompt) => {
    const userGoal = getUserGoalText(goalPrompt);
    const mentionsMvc = /\b(?:mvc|model[-\s]*view[-\s]*controller)\b/i.test(userGoal);
    const mentionsServiceLayer = /\bservice(?:s|\s+layer|\s+pattern)?\b/i.test(userGoal);
    const requestsChange = /\b(?:add|create|build|generate|setup|set\s+up|initialize|scaffold|implement|configure)\b/i.test(userGoal);
    const isDesktopProjectRequest = /\b(?:desktop|project|app(?:lication)?|folder|directory)\b/i.test(
        `${userGoal} ${goalPrompt || ''}`,
    );

    if ((!mentionsMvc && !mentionsServiceLayer)
        || !requestsChange
        || !isDesktopProjectRequest) {
        return tasks;
    }

    const directoryTasks = tasks.filter((task) => {
        const action = String(task.toolInput?.action || '').trim().toLowerCase();
        return action === 'createdirectory'
            || action === 'create_directory'
            || action === 'createdesktopdirectory'
            || action === 'create_desktop_directory';
    });

    const taskDirectoryPaths = directoryTasks
        .map((task) => cleanRelativeDirectoryPath(task.toolInput?.path))
        .filter(Boolean);
    const inferredPath = cleanRelativeDirectoryPath(
        inferDirectoryPath({title: '', instruction: ''}, {}, goalPrompt),
    );
    const firstTaskPath = taskDirectoryPaths[0] || '';
    const projectPath = inferredPath
        ? inferredPath.split('/')[0]
        : firstTaskPath.split('/')[0];

    if (!projectPath) {
        return tasks;
    }

    const projectPrefix = `${projectPath}/`;
    const knownPaths = new Set(taskDirectoryPaths);
    const architectureBase = taskDirectoryPaths.find((directoryPath) => (
        directoryPath === `${projectPath}/src`
        || directoryPath === `${projectPath}/app`
    )) || projectPath;

    // MVC + Service means the four conventional application boundaries. Only
    // add directories named by the requested architecture; feature files and
    // unrelated folders still come from the planner's user-specific plan.
    const requestedDirectories = [
        ...(mentionsMvc ? ['controllers', 'models', 'views'] : []),
        ...(mentionsServiceLayer ? ['services'] : []),
    ];

    const isExistingProjectUpdate = isExplicitExistingProjectUpdateRequest(goalPrompt);
    const useDesktopPaths = isExistingProjectUpdate || isNodeProjectSetupRequest(goalPrompt);
    let nextTasks = [...tasks];

    let rootTask = directoryTasks.find((task) => (
        cleanRelativeDirectoryPath(task.toolInput?.path) === projectPath
    ));

    if (!rootTask && useDesktopPaths) {
        rootTask = {
            nodeKey: getUniqueNodeKey(nextTasks, 'ensure_desktop_project_directory'),
            title: `Ensure Desktop directory ${projectPath}`,
            instruction: `Ensure the existing project directory ${projectPath} is available on the local Desktop.`,
            dependencies: [],
            assignedTool: 'fileManager',
            toolInput: {
                action: 'createDesktopDirectory',
                path: projectPath,
            },
        };
        nextTasks.unshift(rootTask);
        knownPaths.add(projectPath);
    }

    const baseTask = directoryTasks.find((task) => (
        cleanRelativeDirectoryPath(task.toolInput?.path) === architectureBase
    ));
    if (baseTask) {
        knownPaths.add(architectureBase);
    }

    if (!knownPaths.has(architectureBase)) {
        const baseNodeKey = getUniqueNodeKey(nextTasks, 'create_architecture_directory');
        const createdBaseTask = {
            nodeKey: baseNodeKey,
            title: `Create architecture directory ${architectureBase}`,
            instruction: `Create the architecture directory ${architectureBase}.`,
            dependencies: rootTask ? [rootTask.nodeKey] : [],
            assignedTool: 'fileManager',
            toolInput: {
                action: useDesktopPaths ? 'createDesktopDirectory' : 'createDirectory',
                path: architectureBase,
            },
        };
        nextTasks.push(createdBaseTask);
        knownPaths.add(architectureBase);
    }

    const parentTask = nextTasks.find((task) => (
        cleanRelativeDirectoryPath(task.toolInput?.path) === architectureBase
    ));

    for (const directoryName of [...new Set(requestedDirectories)]) {
        const directoryPath = `${architectureBase}/${directoryName}`;
        if (knownPaths.has(directoryPath)) {
            continue;
        }

        nextTasks.push({
            nodeKey: getUniqueNodeKey(nextTasks, `create_${directoryName}_directory`),
            title: `Create ${directoryName} directory`,
            instruction: `Create the ${directoryName} directory inside ${architectureBase}.`,
            dependencies: parentTask ? [parentTask.nodeKey] : (rootTask ? [rootTask.nodeKey] : []),
            assignedTool: 'fileManager',
            toolInput: {
                action: useDesktopPaths ? 'createDesktopDirectory' : 'createDirectory',
                path: directoryPath,
            },
        });
        knownPaths.add(directoryPath);
    }

    if (useDesktopPaths) {
        const removedExportKeys = new Set(
            nextTasks
                .filter((task) => {
                    const action = String(task.toolInput?.action || '').trim().toLowerCase();
                    return action === 'exportworkspacetodesktop'
                        || action === 'export_workspace_to_desktop';
                })
                .map((task) => task.nodeKey),
        );

        if (removedExportKeys.size) {
            nextTasks = nextTasks
                .filter((task) => !removedExportKeys.has(task.nodeKey))
                .map((task) => ({
                    ...task,
                    dependencies: (task.dependencies || [])
                        .filter((dependency) => !removedExportKeys.has(dependency)),
                }));
        }
    }

    // A path such as `Testing-Product/src` belongs under the project root,
    // never beside it. Ensure the parent project task is also respected by
    // the DAG so nested folders cannot run before the requested project root.
    return nextTasks.map((task) => {
        const pathValue = cleanRelativeDirectoryPath(task.toolInput?.path);
        if (!rootTask
            || !pathValue
            || pathValue === projectPath
            || !pathValue.startsWith(projectPrefix)
            || task.nodeKey === rootTask.nodeKey) {
            return task;
        }

        return {
            ...task,
            dependencies: [...new Set([...(task.dependencies || []), rootTask.nodeKey])],
        };
    });
};


const normalizeDynamicNodeDesktopTasks = (tasks, goalPrompt, requestedDirectoryPath) => {
    const directoryPath = cleanRelativeDirectoryPath(requestedDirectoryPath);
    if (!directoryPath) {
        return tasks;
    }

    const normalizeDesktopCommandCwd = (value) => {
        const requestedCwd = cleanRelativeDirectoryPath(value);
        if (!requestedCwd || requestedCwd === '.' || requestedCwd === './') {
            return directoryPath;
        }

        if (requestedCwd === directoryPath || requestedCwd.startsWith(`${directoryPath}/`)) {
            return requestedCwd;
        }

        return `${directoryPath}/${requestedCwd}`;
    };

    const isDirectoryAction = (action) => DIRECTORY_ACTIONS.has(action)
        || action === 'createdesktopdirectory'
        || action === 'create_desktop_directory';
    const isFileAction = (action) => FILE_WRITE_ACTIONS.has(action)
        || action === 'createdesktopfile'
        || action === 'create_desktop_file'
        || action === 'createdesktopfiles'
        || action === 'create_desktop_files';
    const sourceDirectories = inferProjectSourceDirectories(tasks, directoryPath);
    const prefixFilePath = (filePath, task) => normalizeNodeProjectFilePath(
        filePath,
        task,
        directoryPath,
    );

    let nextTasks = tasks.map((task) => {
        const action = String(task.toolInput?.action || '').trim().toLowerCase();
        const tool = String(task.assignedTool || '').trim().toLowerCase();

        if (isDirectoryAction(action)) {
            const normalizedDirectoryPath = normalizeNodeProjectDirectoryPath(
                task.toolInput?.path,
                directoryPath,
                sourceDirectories,
            ) || directoryPath;

            return {
                ...task,
                assignedTool: 'fileManager',
                toolInput: {
                    ...task.toolInput,
                    action: 'createDesktopDirectory',
                    path: normalizedDirectoryPath,
                },
            };
        }

        if ((tool === 'filemanager' || tool === 'file_manager') && isFileAction(action)) {
            const files = Array.isArray(task.toolInput?.files)
                ? task.toolInput.files
                : task.toolInput?.files && typeof task.toolInput.files === 'object'
                    ? Object.entries(task.toolInput.files).map(([filePath, content]) => ({path: filePath, content}))
                    : null;

            if (files) {
                const normalizedFiles = files
                    .map((file) => {
                        const filePath = prefixFilePath(file?.path || file?.fileName, task);
                        return filePath ? {...file, path: filePath} : null;
                    })
                    .filter(Boolean);

                if (!normalizedFiles.length) {
                    throw new Error(
                        `The planner generated a Desktop file task without valid file paths inside ${directoryPath}. Regenerate the plan with one path per file.`,
                    );
                }

                return {
                    ...task,
                    assignedTool: 'fileManager',
                    toolInput: {
                        ...task.toolInput,
                        action: 'createDesktopFiles',
                        files: normalizedFiles,
                    },
                };
            }

            const filePath = prefixFilePath(task.toolInput?.path, task);
            if (filePath) {
                if (filePath === directoryPath) {
                    throw new Error(
                        `The planner targeted the project directory ${directoryPath} as a file. Regenerate the plan with an actual filename.`,
                    );
                }

                return {
                    ...task,
                    assignedTool: 'fileManager',
                    toolInput: {
                        ...task.toolInput,
                        action: 'createDesktopFile',
                        path: filePath,
                    },
                };
            }
        }

        if (tool === 'executecommand' || tool === 'execute_command') {
            return {
                ...task,
                assignedTool: 'executeCommand',
                toolInput: {
                    ...task.toolInput,
                    // Never allow `cwd: "."` to resolve to the Desktop root.
                    // Every project command must run inside the requested
                    // project folder or one of its explicit subdirectories.
                    cwd: normalizeDesktopCommandCwd(
                        task.toolInput?.cwd || task.toolInput?.workingDirectory,
                    ),
                    desktop: true,
                },
            };
        }

        return task;
    });

    // A malformed plan often contains both `Rent-Room/src` and the same
    // directory under an accidental nested path. Keep one canonical task and
    // redirect dependants instead of creating duplicate empty folders.
    nextTasks = deduplicateProjectDirectoryTasks(nextTasks, isDirectoryAction);

    let directoryTask = nextTasks.find((task) => {
        const action = String(task.toolInput?.action || '').trim().toLowerCase();
        return isDirectoryAction(action);
    });

    if (!directoryTask) {
        const existingKeys = new Set(nextTasks.map((task) => task.nodeKey));
        let nodeKey = 'create_node_desktop_directory';
        let suffix = 2;
        while (existingKeys.has(nodeKey)) {
            nodeKey = 'create_node_desktop_directory_' + suffix;
            suffix += 1;
        }

        directoryTask = {
            nodeKey,
            title: 'Create Desktop directory ' + directoryPath,
            instruction: 'Create the requested project directory ' + directoryPath + ' on the local Desktop.',
            dependencies: [],
            assignedTool: 'fileManager',
            toolInput: {
                action: 'createDesktopDirectory',
                path: directoryPath,
            },
        };
        nextTasks = [directoryTask, ...nextTasks];
    }

    nextTasks = nextTasks.map((task) => {
        const action = String(task.toolInput?.action || '').trim().toLowerCase();
        if (task.nodeKey === directoryTask.nodeKey || !isFileAction(action)) {
            return task;
        }

        return {
            ...task,
            dependencies: [...new Set([...(task.dependencies || []), directoryTask.nodeKey])],
        };
    });

    const explicitNodeRequest = /\bnode(?:\.js|\s*js)?\b/i.test(String(goalPrompt || ''));
    const explicitPhpRequest = /\bphp\b/i.test(String(goalPrompt || ''));
    if (explicitNodeRequest && !explicitPhpRequest) {
        const phpTask = nextTasks.find((task) => /\.php\b/i.test(JSON.stringify(task)));
        if (phpTask) {
            throw new Error('The planner generated PHP files for a Node.js request. Regenerate the files using the runtime and filenames from the user prompt.');
        }
    }

    return nextTasks;
};

const ensureNodeDesktopProjectTasks = (tasks, goalPrompt) => {
    if (!isNodeProjectSetupRequest(goalPrompt)) {
        return tasks;
    }

    const requestedDirectoryPath = cleanRelativeDirectoryPath(
        inferDirectoryPath({title: '', instruction: ''}, {}, goalPrompt),
    );

    if (!requestedDirectoryPath) {
        return tasks;
    }

    return normalizeDynamicNodeDesktopTasks(tasks, goalPrompt, requestedDirectoryPath);

};

const getProjectFileEntries = (task) => {
    const action = String(task.toolInput?.action || '').trim().toLowerCase();
    const isFileAction = FILE_WRITE_ACTIONS.has(action)
        || action === 'createdesktopfile'
        || action === 'create_desktop_file'
        || action === 'createdesktopfiles'
        || action === 'create_desktop_files';

    if (!isFileAction) {
        return [];
    }

    if (Array.isArray(task.toolInput?.files)) {
        return task.toolInput.files
            .map((file, index) => ({
                path: file?.path || file?.fileName,
                content: file?.content,
                index,
            }))
            .filter((file) => file.path);
    }

    if (task.toolInput?.files && typeof task.toolInput.files === 'object') {
        return Object.entries(task.toolInput.files).map(([filePath, content], index) => ({
            path: filePath,
            content,
            index,
        }));
    }

    return task.toolInput?.path
        || task.toolInput?.fileName
        ? [{
            path: task.toolInput.path || task.toolInput.fileName,
            content: task.toolInput.content,
        }]
        : [];
};

const ensureExplicitProjectTreeDirectories = (tasks, goalPrompt) => {
    if (!isNodeProjectSetupRequest(goalPrompt)) {
        return tasks;
    }

    const layout = extractProjectTreeLayout(goalPrompt);
    if (!layout.files.length && !layout.directories.length) {
        return tasks;
    }

    const projectRoot = cleanRelativeDirectoryPath(
        inferDirectoryPath({title: '', instruction: ''}, {}, goalPrompt),
    );
    if (!projectRoot) {
        return tasks;
    }

    const isDirectoryAction = (action) => DIRECTORY_ACTIONS.has(action)
        || action === 'createdesktopdirectory'
        || action === 'create_desktop_directory';
    const nextTasks = [...tasks];
    const directoryTasks = new Map();

    for (const task of nextTasks) {
        const action = String(task.toolInput?.action || '').trim().toLowerCase();
        if (!isDirectoryAction(action)) {
            continue;
        }

        const directoryPath = canonicalizeProjectPath(task.toolInput?.path, projectRoot)
            || cleanRelativeDirectoryPath(task.toolInput?.path);
        if (directoryPath) {
            directoryTasks.set(directoryPath, task);
        }
    }

    const addDirectoryTask = (directoryPath, parentTask) => {
        const existingTask = directoryTasks.get(directoryPath);
        if (existingTask) {
            return existingTask;
        }

        const task = {
            nodeKey: getUniqueNodeKey(nextTasks, `create_${directoryPath.replace(/[^A-Za-z0-9]+/g, '_').toLowerCase()}_directory`),
            title: `Create Desktop directory ${directoryPath}`,
            instruction: `Create the requested directory ${directoryPath} on the local Desktop.`,
            dependencies: parentTask ? [parentTask.nodeKey] : [],
            assignedTool: 'fileManager',
            toolInput: {
                action: 'createDesktopDirectory',
                path: directoryPath,
            },
        };

        nextTasks.push(task);
        directoryTasks.set(directoryPath, task);
        return task;
    };

    const rootTask = addDirectoryTask(projectRoot, null);
    const requestedDirectories = [...new Set(layout.directories)]
        .map((relativePath) => `${projectRoot}/${relativePath}`)
        .sort((left, right) => left.split('/').length - right.split('/').length);

    for (const directoryPath of requestedDirectories) {
        const parentPath = directoryPath.slice(0, directoryPath.lastIndexOf('/')) || projectRoot;
        const parentTask = directoryTasks.get(parentPath) || rootTask;
        addDirectoryTask(directoryPath, parentTask);
    }

    const requestedDirectoryPaths = new Set([
        projectRoot,
        ...requestedDirectories,
    ].map((directoryPath) => directoryPath.toLowerCase()));
    const requestedFilePaths = new Set(
        layout.files.map((relativePath) => `${projectRoot}/${relativePath}`.toLowerCase()),
    );
    const requestedFileByBasename = new Map();
    for (const filePath of requestedFilePaths) {
        const fileName = path.basename(filePath);
        if (requestedFileByBasename.has(fileName)) {
            requestedFileByBasename.set(fileName, null);
        } else {
            requestedFileByBasename.set(fileName, filePath);
        }
    }

    const removedDirectoryKeys = new Set();
    const filteredTasks = nextTasks.filter((task) => {
        const action = String(task.toolInput?.action || '').trim().toLowerCase();
        if (!isDirectoryAction(action)) {
            return true;
        }

        const canonicalPath = canonicalizeProjectPath(task.toolInput?.path, projectRoot);
        if (!canonicalPath || !canonicalPath.toLowerCase().startsWith(`${projectRoot.toLowerCase()}/`)) {
            return true;
        }

        if (requestedDirectoryPaths.has(canonicalPath.toLowerCase())) {
            return true;
        }

        removedDirectoryKeys.add(task.nodeKey);
        return false;
    });

    const normalizedTasks = filteredTasks.map((task) => {
        const action = String(task.toolInput?.action || '').trim().toLowerCase();
        if (isDirectoryAction(action)) {
            const canonicalPath = canonicalizeProjectPath(task.toolInput?.path, projectRoot);
            if (canonicalPath && requestedDirectoryPaths.has(canonicalPath.toLowerCase())) {
                return {
                    ...task,
                    assignedTool: 'fileManager',
                    toolInput: {
                        ...task.toolInput,
                        action: 'createDesktopDirectory',
                        path: canonicalPath,
                    },
                };
            }
        }

        const fileEntries = getProjectFileEntries(task);
        if (!fileEntries.length) {
            return task;
        }

        const remapFilePath = (filePath) => {
            const canonicalPath = canonicalizeProjectPath(filePath, projectRoot);
            if (!canonicalPath) {
                return filePath;
            }

            const lowerPath = canonicalPath.toLowerCase();
            if (requestedFilePaths.has(lowerPath)) {
                return canonicalPath;
            }

            const basenameMatch = requestedFileByBasename.get(path.basename(lowerPath));
            return basenameMatch || filePath;
        };

        if (Array.isArray(task.toolInput?.files)) {
            return {
                ...task,
                toolInput: {
                    ...task.toolInput,
                    files: task.toolInput.files.map((file) => ({
                        ...file,
                        path: remapFilePath(file?.path || file?.fileName),
                    })),
                },
            };
        }

        if (task.toolInput?.files && typeof task.toolInput.files === 'object') {
            return {
                ...task,
                toolInput: {
                    ...task.toolInput,
                    files: Object.fromEntries(Object.entries(task.toolInput.files).map(([filePath, content]) => (
                        [remapFilePath(filePath), content]
                    ))),
                },
            };
        }

        return {
            ...task,
            toolInput: {
                ...task.toolInput,
                path: remapFilePath(task.toolInput.path),
            },
        };
    });

    const normalizedDirectoryTasks = new Map();
    for (const task of normalizedTasks) {
        const action = String(task.toolInput?.action || '').trim().toLowerCase();
        if (!isDirectoryAction(action)) {
            continue;
        }

        const directoryPath = cleanRelativeDirectoryPath(task.toolInput?.path);
        if (directoryPath) {
            normalizedDirectoryTasks.set(directoryPath.toLowerCase(), task);
        }
    }

    return normalizedTasks.map((task) => {
        const fileEntries = getProjectFileEntries(task);
        if (!fileEntries.length) {
            return {
                ...task,
                dependencies: (task.dependencies || [])
                    .filter((dependency) => !removedDirectoryKeys.has(dependency)),
            };
        }

        const fileDependencies = fileEntries
            .map((entry) => cleanRelativeFilePath(entry.path))
            .filter(Boolean)
            .map((filePath) => {
                const canonicalPath = canonicalizeProjectPath(filePath, projectRoot);
                if (!canonicalPath) {
                    return null;
                }

                const parentPath = canonicalPath.slice(0, canonicalPath.lastIndexOf('/')) || projectRoot;
                return normalizedDirectoryTasks.get(parentPath.toLowerCase())?.nodeKey || rootTask.nodeKey;
            })
            .filter(Boolean);

        return {
            ...task,
            dependencies: [...new Set([...(task.dependencies || [])
                .filter((dependency) => !removedDirectoryKeys.has(dependency)), ...fileDependencies])]
                .filter((dependency) => dependency !== task.nodeKey),
        };
    });
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

const isExplicitBuildRequest = (goalPrompt) => {
    const text = String(goalPrompt || '');
    return /\b(?:build|compile|production\s+build)\b/i.test(text)
        && /\b(?:run|execute|verify|check|test|project|application|app|setup|set\s+up|create|generate)\b/i.test(text);
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

const isExplicitLintRequest = (goalPrompt) => /\b(?:lint|linting|eslint|prettier)\b/i.test(String(goalPrompt || ''));

const isProjectPreparationRequest = (goalPrompt) => {
    const userGoal = getUserGoalText(goalPrompt);
    const mentionsPreparation = /\b(?:clean|cleanup|clean-up|tidy|organize|prepare)\b/i.test(userGoal);
    const mentionsProject = /\b(?:project|codebase|repository|repo|workspace|application|app)\b/i.test(userGoal);
    const explicitlyRequestsVerification = /\b(?:build|compile|test|tests|lint|eslint|prettier|verify|check|run|start|serve|deploy|install)\b/i.test(userGoal);

    return mentionsPreparation
        && mentionsProject
        && !explicitlyRequestsVerification;
};

const isLintCommandTask = (task) => {
    if (String(task.assignedTool || '').trim() !== 'executeCommand') {
        return false;
    }

    const command = String(task.toolInput?.command || '').trim();
    return /\bnpm\s+(?:run\s+)?lint\b/i.test(command)
        || /\b(?:pnpm|yarn)\s+lint\b/i.test(command)
        || /\bbun\s+(?:run\s+)?lint\b/i.test(command)
        || /\b(?:npx\s+)?eslint(?:\s|$)/i.test(command);
};

const normalizePromptVerificationTasks = (tasks, goalPrompt) => {
    // A project setup prompt must not acquire an invented lint command. Keep it
    // only when the user explicitly requested linting/ESLint/Prettier.
    if (isExplicitLintRequest(goalPrompt)) {
        return tasks;
    }

    const removedKeys = new Set(
        tasks.filter(isLintCommandTask).map((task) => task.nodeKey),
    );

    if (!removedKeys.size) {
        return tasks;
    }

    return tasks
        .filter((task) => !removedKeys.has(task.nodeKey))
        .map((task) => ({
            ...task,
            dependencies: (task.dependencies || []).filter((dependency) => !removedKeys.has(dependency)),
        }));
};

const isUnrequestedVerificationTask = (task) => {
    const tool = String(task.assignedTool || '').trim().toLowerCase();
    const toolInput = task.toolInput || {};
    const command = String(toolInput.command || '').trim();
    const taskText = `${task.title || ''} ${task.instruction || ''} ${command}`;

    if (tool === 'executecommand' || tool === 'execute_command') {
        return /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|test|lint|typecheck)\b/i.test(command)
            || /\b(?:vite\s+build|eslint|prettier|tsc(?:\s|$))\b/i.test(command);
    }

    return /\b(?:production\s+build|build\s+verification|run\s+(?:the\s+)?tests?|lint(?:ing)?|type\s*check|code[-\s]quality\s+check|project\s+verification)\b/i.test(taskText);
};

const normalizeProjectPreparationTasks = (tasks, goalPrompt) => {
    if (!isProjectPreparationRequest(goalPrompt)) {
        return tasks;
    }

    const removedKeys = new Set(
        tasks.filter(isUnrequestedVerificationTask).map((task) => task.nodeKey),
    );

    const preparedTasks = tasks
        .filter((task) => !removedKeys.has(task.nodeKey))
        .map((task) => ({
            ...task,
            dependencies: (task.dependencies || []).filter((dependency) => !removedKeys.has(dependency)),
        }));

    if (preparedTasks.length > 0 || !removedKeys.size) {
        return preparedTasks;
    }

    const projectPath = inferExistingDesktopProjectPath(tasks, goalPrompt);
    if (!projectPath) {
        return [{
            nodeKey: getUniqueNodeKey([], 'inspect_project_before_cleanup'),
            title: 'Inspect the project before cleanup',
            instruction: 'Inspect the current project structure before cleanup. Do not create, overwrite, move, or delete files automatically.',
            dependencies: [],
            assignedTool: 'executeCommand',
            toolInput: {
                command: 'pwd',
            },
        }];
    }

    return [{
        nodeKey: getUniqueNodeKey([], 'inspect_project_before_cleanup'),
        title: `Inspect Desktop project ${projectPath} before cleanup`,
        instruction: `Inspect the existing Desktop project ${projectPath} before cleanup. Do not create, overwrite, move, or delete files automatically.`,
        dependencies: [],
        assignedTool: 'fileManager',
        toolInput: {
            action: 'listDesktopDirectory',
            path: projectPath,
            allowMissing: false,
        },
    }];
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

    if (!isExplicitBuildRequest(goalPrompt)) {
        return nextTasks;
    }

    const buildScriptCommand = 'npm pkg set scripts.build="vite build"';
    let buildScriptTask = nextTasks.find((task) => /npm\s+pkg\s+set\s+scripts\.build=/i.test(String(task.toolInput?.command || '')));

    if (buildScriptTask) {
        const buildScriptIndex = nextTasks.indexOf(buildScriptTask);
        buildScriptTask = {
            ...buildScriptTask,
            title: 'Ensure the Vue build script exists',
            instruction: `Ensure ${requestedDirectoryPath}/package.json contains the build script "build": "vite build".`,
            dependencies: [...new Set([...(buildScriptTask.dependencies || []), installTask.nodeKey])]
                .filter((dependency) => dependency !== buildScriptTask.nodeKey),
            assignedTool: 'executeCommand',
            toolInput: {
                command: buildScriptCommand,
                cwd: requestedDirectoryPath,
                desktop: true,
            },
        };
        nextTasks[buildScriptIndex] = buildScriptTask;
    } else {
        buildScriptTask = {
            nodeKey: getUniqueNodeKey(nextTasks, 'ensure_vue_build_script'),
            title: 'Ensure the Vue build script exists',
            instruction: `Ensure ${requestedDirectoryPath}/package.json contains the build script "build": "vite build".`,
            dependencies: [installTask.nodeKey],
            assignedTool: 'executeCommand',
            toolInput: {
                command: buildScriptCommand,
                cwd: requestedDirectoryPath,
                desktop: true,
            },
        };
        nextTasks.push(buildScriptTask);
    }

    let buildTask = nextTasks.find((task) => /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b/i.test(String(task.toolInput?.command || '')));

    if (buildTask) {
        const buildIndex = nextTasks.indexOf(buildTask);
        buildTask = {
            ...buildTask,
            title: 'Verify the Vue production build',
            instruction: `Run the Vue production build in ${requestedDirectoryPath}.`,
            dependencies: [...new Set([...(buildTask.dependencies || []), buildScriptTask.nodeKey])]
                .filter((dependency) => dependency !== buildTask.nodeKey),
            assignedTool: 'executeCommand',
            toolInput: {
                command: 'npm run build',
                cwd: requestedDirectoryPath,
                desktop: true,
            },
        };
        nextTasks[buildIndex] = buildTask;
    } else {
        nextTasks.push({
            nodeKey: getUniqueNodeKey(nextTasks, 'verify_vue_build'),
            title: 'Verify the Vue production build',
            instruction: `Run the Vue production build in ${requestedDirectoryPath}.`,
            dependencies: [buildScriptTask.nodeKey],
            assignedTool: 'executeCommand',
            toolInput: {
                command: 'npm run build',
                cwd: requestedDirectoryPath,
                desktop: true,
            },
        });
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

const isVueBuildRequest = (goalPrompt) => {
    const text = String(goalPrompt || '');
    return LOCAL_DESKTOP_OUTPUT_ENABLED
        && /\b(?:vue(?:\.js)?|vue\s*3|vue3|vite)\b/i.test(text)
        && isExplicitBuildRequest(goalPrompt);
};

const isIndexHtmlTask = (task) => {
    const action = String(task.toolInput?.action || '').trim().toLowerCase();
    const directPath = String(task.toolInput?.path || '').replace(/\\/g, '/');
    const files = Array.isArray(task.toolInput?.files)
        ? task.toolInput.files
        : task.toolInput?.files && typeof task.toolInput.files === 'object'
            ? Object.entries(task.toolInput.files).map(([filePath]) => ({path: filePath}))
            : [];

    return (action === 'createdesktopfile' || action === 'create_desktop_file'
        || action === 'create' || action === 'createfile' || action === 'create_file'
        || action === 'update' || action === 'updatefile' || action === 'update_file'
        || action === 'createfiles' || action === 'create_files'
        || action === 'createdesktopfiles' || action === 'create_desktop_files')
        && (/\/(?:index\.html?)$/i.test(directPath) || /^(?:index\.html?)$/i.test(directPath)
            || files.some((file) => /(?:^|\/)index\.html?$/i.test(String(file?.path || '').replace(/\\/g, '/'))));
};

const ensureVueEntryPointTask = (tasks, goalPrompt) => {
    if (!isVueBuildRequest(goalPrompt)) {
        return tasks;
    }

    const requestedDirectoryPath = cleanRelativeDirectoryPath(
        inferDirectoryPath({title: '', instruction: ''}, {}, goalPrompt),
    );

    if (!requestedDirectoryPath || tasks.some(isIndexHtmlTask)) {
        return tasks;
    }

    const directoryTask = tasks.find((task) => (
        isDesktopDirectoryTask(task)
        && cleanRelativeDirectoryPath(task.toolInput?.path) === requestedDirectoryPath
    ));
    const entryTask = {
        nodeKey: getUniqueNodeKey(tasks, 'ensure_vue_entry_point'),
        title: 'Ensure the Vue index.html entry point',
        instruction: `Create the missing root index.html for the Vue project in Desktop/${requestedDirectoryPath} without replacing an existing file.`,
        dependencies: directoryTask ? [directoryTask.nodeKey] : [],
        assignedTool: 'fileManager',
        toolInput: {
            action: 'createDesktopFile',
            mode: 'create',
            ifExists: 'skip',
            path: `${requestedDirectoryPath}/index.html`,
            content: '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>Vue Application</title>\n  </head>\n  <body>\n    <div id="app"></div>\n    <script type="module" src="/src/main.js"></script>\n  </body>\n</html>\n',
        },
    };

    const buildIndex = tasks.findIndex((task) => (
        task.assignedTool === 'executeCommand'
        && /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b/i.test(String(task.toolInput?.command || ''))
    ));

    if (buildIndex < 0) {
        return [...tasks, entryTask];
    }

    const nextTasks = [...tasks];
    nextTasks.splice(buildIndex, 0, entryTask);
    const shiftedBuildTask = nextTasks[buildIndex + 1];
    nextTasks[buildIndex + 1] = {
        ...shiftedBuildTask,
        dependencies: [...new Set([...(shiftedBuildTask.dependencies || []), entryTask.nodeKey])],
    };

    return nextTasks;
};

const isVueBuildPlan = (tasks, goalPrompt) => {
    const goalText = String(goalPrompt || '');
    const planText = tasks.map((task) => {
        const toolInput = task.toolInput || {};
        const files = Array.isArray(toolInput.files)
            ? toolInput.files.map((file) => file?.path || '').join(' ')
            : '';
        return `${task.title || ''} ${task.instruction || ''} ${toolInput.command || ''} ${toolInput.path || ''} ${files}`;
    }).join(' ');

    const mentionsVue = /\b(?:vue(?:\.js)?|vue\s*3|vue3|vite)\b/i.test(`${goalText} ${planText}`);
    const hasVueSource = /(?:^|[\s/])[^\s/]+\.vue\b/i.test(planText);
    const hasBuildTask = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|\bvite\s+build\b/i.test(planText);

    // A generated task must not upgrade a generic cleanup/preparation request
    // into a production build. Verification is allowed only when the user
    // explicitly requested it, while the source/build checks still protect
    // explicit Vue build requests whose wording omits the framework name.
    return LOCAL_DESKTOP_OUTPUT_ENABLED
        && mentionsVue
        && isExplicitBuildRequest(goalPrompt)
        && (isVueBuildRequest(goalPrompt) || (hasVueSource && hasBuildTask));
};

const isViteConfigTask = (task) => {
    const toolInput = task.toolInput || {};
    const directPath = String(toolInput.path || '').replace(/\\/g, '/');
    const files = Array.isArray(toolInput.files)
        ? toolInput.files.map((file) => file?.path || '').join(' ')
        : '';
    return /(?:^|\/)vite\.config\.(?:js|mjs|ts)$/i.test(`${directPath} ${files}`);
};

const ensureVueBuildToolingTasks = (tasks, goalPrompt) => {
    if (!isVueBuildPlan(tasks, goalPrompt)) {
        return tasks;
    }

    const requestedDirectoryPath = inferExistingDesktopProjectPath(tasks, goalPrompt);
    if (!requestedDirectoryPath) {
        return tasks;
    }

    const nextTasks = [...tasks];
    const directoryTask = nextTasks.find((task) => (
        isDesktopDirectoryTask(task)
        && cleanRelativeDirectoryPath(task.toolInput?.path) === requestedDirectoryPath
    ));
    const directoryDependency = directoryTask?.nodeKey ? [directoryTask.nodeKey] : [];

    let pluginInstallTask = nextTasks.find((task) => {
        const command = String(task.toolInput?.command || '');
        return /(?:npm|pnpm|yarn|bun)\s+install\b[\s\S]*@vitejs\/plugin-vue/i.test(command);
    });

    if (!pluginInstallTask) {
        pluginInstallTask = {
            nodeKey: getUniqueNodeKey(nextTasks, 'install_vue_vite_plugin'),
            title: 'Install the Vue Vite plugin',
            instruction: `Install @vitejs/plugin-vue in the Vue project inside Desktop/${requestedDirectoryPath}.`,
            dependencies: directoryDependency,
            assignedTool: 'executeCommand',
            toolInput: {
                command: 'npm install --save-dev @vitejs/plugin-vue',
                cwd: requestedDirectoryPath,
                desktop: true,
            },
        };
        nextTasks.push(pluginInstallTask);
    } else {
        pluginInstallTask = {
            ...pluginInstallTask,
            dependencies: [...new Set([...(pluginInstallTask.dependencies || []), ...directoryDependency])],
            toolInput: {
                ...pluginInstallTask.toolInput,
                cwd: requestedDirectoryPath,
                desktop: true,
            },
        };
        nextTasks[nextTasks.findIndex((task) => task.nodeKey === pluginInstallTask.nodeKey)] = pluginInstallTask;
    }

    let configTask = nextTasks.find(isViteConfigTask);
    if (!configTask) {
        configTask = {
            nodeKey: getUniqueNodeKey(nextTasks, 'ensure_vue_vite_config'),
            title: 'Create Vue Vite configuration',
            instruction: `Create vite.config.js in Desktop/${requestedDirectoryPath} with the Vue plugin enabled.`,
            dependencies: [...new Set([...directoryDependency, pluginInstallTask.nodeKey])],
            assignedTool: 'fileManager',
            toolInput: {
                action: DESKTOP_FILE_ACTION,
                mode: 'create',
                ifExists: 'skip',
                path: `${requestedDirectoryPath}/vite.config.js`,
                content: "import { defineConfig } from 'vite';\nimport vue from '@vitejs/plugin-vue';\n\nexport default defineConfig({\n  plugins: [vue()],\n});\n",
            },
        };
        nextTasks.push(configTask);
    } else {
        configTask = {
            ...configTask,
            dependencies: [...new Set([...(configTask.dependencies || []), pluginInstallTask.nodeKey])],
        };
        nextTasks[nextTasks.findIndex((task) => task.nodeKey === configTask.nodeKey)] = configTask;
    }

    return nextTasks.map((task) => {
        const command = String(task.toolInput?.command || '');
        if (!/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|\bvite\s+build\b/i.test(command)) {
            return task;
        }

        return {
            ...task,
            dependencies: [...new Set([...(task.dependencies || []), pluginInstallTask.nodeKey, configTask.nodeKey])],
        };
    });
};

const normalizeGitBranchTasks = (tasks) => {
    if (!Array.isArray(tasks)) return tasks;

    const commitIdx = tasks.findIndex((t) => {
        const cmd = String(t.toolInput?.command || '').toLowerCase();
        return cmd.includes('git commit');
    });

    const pushIdx = tasks.findIndex((t) => {
        const cmd = String(t.toolInput?.command || '').toLowerCase();
        return cmd.includes('git push');
    });

    const hasBranchMain = tasks.some((t) => {
        const cmd = String(t.toolInput?.command || '').toLowerCase();
        return cmd.includes('git branch -m') || cmd.includes('git checkout -b main');
    });

    if (pushIdx !== -1 && !hasBranchMain) {
        const pushTask = tasks[pushIdx];
        const branchTask = {
            nodeKey: 'git_branch_main',
            title: 'Set default branch to main',
            instruction: 'Rename current branch to main for GitHub compatibility',
            dependencies: commitIdx !== -1 ? [tasks[commitIdx].nodeKey] : (pushTask.dependencies || []),
            assignedTool: 'executeCommand',
            toolInput: {
                command: 'git branch -M main',
                cwd: pushTask.toolInput?.cwd,
                desktop: pushTask.toolInput?.desktop,
            },
        };

        pushTask.dependencies = Array.from(new Set([...(pushTask.dependencies || []), 'git_branch_main']));

        const insertAt = commitIdx !== -1 ? commitIdx + 1 : pushIdx;
        const updated = [...tasks];
        updated.splice(insertAt, 0, branchTask);
        return updated;
    }

    return tasks;
};

const generateDynamicCommitMessage = (goalPrompt = '', tasks = []) => {
    const text = String(goalPrompt || '').trim();

    // 1. Explicit commit message in user prompt
    const quotedMatch = text.match(/(?:commit\s+(?:with\s+)?(?:message|msg|-m)?\s*["'“]([^"'”]+)["'”])/i);
    if (quotedMatch && quotedMatch[1]?.trim()) {
        return quotedMatch[1].trim();
    }

    // 2. Identify modified or created files from tasks
    const changedFiles = [];
    if (Array.isArray(tasks)) {
        tasks.forEach((t) => {
            if (t.assignedTool === 'fileManager') {
                const p = t.toolInput?.path || t.toolInput?.filePath;
                if (p && typeof p === 'string') {
                    const base = p.split(/[\\/]/).pop();
                    if (base && !changedFiles.includes(base)) changedFiles.push(base);
                }
            }
        });
    }

    const fileScope = changedFiles.length === 1 ? `(${changedFiles[0]})` : '';

    // 3. Dynamic semantic intent inference
    if (/\b(?:cannot\s+get|404|route|not\s+found)\b/i.test(text)) {
        return `fix${fileScope}: add root route handler to resolve 404 Cannot GET /`;
    }
    if (/\b(?:fix|repair|bug|error|issue|problem|broken|crash)\b/i.test(text)) {
        const cleanGoal = text
            .replace(/^please\s+/i, '')
            .replace(/^i want (?:to )?/i, '')
            .replace(/\b(?:review and |please )\b/i, '')
            .replace(/https?:\/\/[^\s]+/i, '')
            .trim();
        return `fix${fileScope}: ${cleanGoal ? cleanGoal.slice(0, 68) : 'resolve server runtime issues'}`;
    }
    if (/\b(?:add|create|new|implement|feature)\b/i.test(text)) {
        const cleanGoal = text
            .replace(/^please\s+/i, '')
            .replace(/^i want (?:to )?/i, '')
            .trim();
        return `feat${fileScope}: ${cleanGoal ? cleanGoal.slice(0, 68) : 'add requested application features'}`;
    }
    if (/\b(?:refactor|clean|structure|mvc|service)\b/i.test(text)) {
        return `refactor${fileScope}: reorganize project architecture and modularize code`;
    }
    if (/\b(?:docs?|readme)\b/i.test(text)) {
        return `docs: update documentation and project specifications`;
    }
    if (/\b(?:push|deploy|publish|release)\b/i.test(text)) {
        return `chore: prepare changes and deploy to production`;
    }

    const cleanText = text.replace(/^please\s+/i, '').replace(/^i want (?:to )?/i, '').trim();
    return `chore: ${cleanText ? cleanText.slice(0, 68) : 'update project files and configurations'}`;
};

const normalizeGitCommitTasks = (tasks, goalPrompt) => {
    if (!Array.isArray(tasks) || !tasks.length) return tasks;

    const dynamicMsg = generateDynamicCommitMessage(goalPrompt, tasks);

    return tasks.map((t) => {
        if (t.assignedTool === 'executeCommand') {
            const cmd = String(t.toolInput?.command || '').trim();
            if (/^git\s+commit\s+-m\s*["'](?:initial\s+commit|update|commit|save|changes)["']$/i.test(cmd)) {
                return {
                    ...t,
                    title: `Commit: ${dynamicMsg}`,
                    instruction: `Commit project changes with message: "${dynamicMsg}"`,
                    toolInput: {
                        ...t.toolInput,
                        command: `git commit -m "${dynamicMsg}"`,
                    },
                };
            }
        }
        return t;
    });
};

const normalizeServerReviewAndFixTasks = (tasks, goalPrompt, localDestination) => {
    const text = String(goalPrompt || '').trim();
    if (!text) return tasks;

    const urlMatch = text.match(/https?:\/\/[^\s]+/i);
    if (!urlMatch) return tasks;

    const targetUrl = urlMatch[0].replace(/[.,;!?]+$/, '');
    const isFixOrReviewRequest = /\b(?:review|modify|fix|update|repair|troubleshoot|debug|solve|check|cannot\s+get|404|error)\b/i.test(text);
    if (!isFixOrReviewRequest) return tasks;

    let projectPath = null;
    const urlDomain = (targetUrl.match(/https?:\/\/([a-z0-9_-]+)/i)?.[1] || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const dest = normalizeLocalDestination(localDestination);
    const destNorm = String(dest?.relativePath || '').toLowerCase().replace(/[^a-z0-9]/g, '');

    // Only accept localDestination if it actually matches the URL domain!
    if (dest?.relativePath && urlDomain && (destNorm.includes(urlDomain) || urlDomain.includes(destNorm))) {
        projectPath = dest.relativePath;
    } else {
        for (const t of tasks) {
            const candidate = t.toolInput?.cwd || t.toolInput?.path;
            if (typeof candidate === 'string' && candidate.toLowerCase().includes('sample-res-tful-api')) {
                projectPath = candidate.replace(/^desktop[\\/]+/i, '').replace(/[\\/]+$/, '');
                break;
            }
        }
        if (!projectPath && /sample-res-tful-api/i.test(targetUrl)) {
            projectPath = 'Api-Productions/Sample-RESTful-API-';
        }
    }

    if (!projectPath) return tasks;

    const desktopProjectPath = `Desktop/${projectPath.replace(/^desktop[\\/]+/i, '')}`;
    const cleanRelativePath = projectPath.replace(/^desktop[\\/]+/i, '').replace(/[\\/]+$/, '');

    const hasHttpTask = tasks.some((t) => t.assignedTool === 'httpRequester');
    const hasCodeUpdateTask = tasks.some((t) => {
        const action = String(t.toolInput?.action || '').toLowerCase();
        return (t.assignedTool === 'fileManager' && ['create', 'update', 'createdesktopfile', 'write'].includes(action) && !action.includes('directory'));
    });
    const hasPushTask = tasks.some((t) => {
        const cmd = String(t.toolInput?.command || '').toLowerCase();
        return t.assignedTool === 'executeCommand' && (cmd.includes('git push') || cmd.includes('push origin'));
    });

    if (hasHttpTask && hasCodeUpdateTask && hasPushTask) {
        return tasks;
    }

    if (hasCodeUpdateTask && !hasPushTask) {
        const updatedTasks = [...tasks];
        const lastTask = tasks[tasks.length - 1];

        const hasCommitTask = tasks.some((t) => {
            const cmd = String(t.toolInput?.command || '').toLowerCase();
            return t.assignedTool === 'executeCommand' && cmd.includes('git commit');
        });

        if (!hasCommitTask) {
            updatedTasks.push({
                nodeKey: 'git_stage_changes',
                title: 'Stage modified files',
                instruction: 'Run git add . to stage server route fixes.',
                dependencies: [lastTask.nodeKey],
                assignedTool: 'executeCommand',
                toolInput: {
                    command: 'git add .',
                    cwd: desktopProjectPath,
                    desktop: true,
                },
            });

            const dynamicCommitMsg = generateDynamicCommitMessage(goalPrompt, tasks);
            updatedTasks.push({
                nodeKey: 'git_commit_changes',
                title: 'Commit server changes',
                instruction: `Commit server route implementation with message: "${dynamicCommitMsg}".`,
                dependencies: ['git_stage_changes'],
                assignedTool: 'executeCommand',
                toolInput: {
                    command: `git commit -m "${dynamicCommitMsg}"`,
                    cwd: desktopProjectPath,
                    desktop: true,
                },
            });
        }

        const commitDep = hasCommitTask
            ? tasks.find((t) => String(t.toolInput?.command || '').toLowerCase().includes('git commit')).nodeKey
            : 'git_commit_changes';

        const hasBranchTask = tasks.some((t) => {
            const cmd = String(t.toolInput?.command || '').toLowerCase();
            return t.assignedTool === 'executeCommand' && (cmd.includes('git branch -m') || cmd.includes('checkout -b main'));
        });

        if (!hasBranchTask) {
            updatedTasks.push({
                nodeKey: 'git_branch_main',
                title: 'Set default branch to main',
                instruction: 'Ensure branch is named main before pushing.',
                dependencies: [commitDep],
                assignedTool: 'executeCommand',
                toolInput: {
                    command: 'git branch -M main',
                    cwd: desktopProjectPath,
                    desktop: true,
                },
            });
        }

        const pushDep = !hasBranchTask ? 'git_branch_main' : commitDep;

        updatedTasks.push({
            nodeKey: 'git_push_deploy',
            title: 'Push changes to deploy',
            instruction: 'Push commit to remote repository to trigger live deployment.',
            dependencies: [pushDep],
            assignedTool: 'executeCommand',
            toolInput: {
                command: 'git push origin main',
                cwd: desktopProjectPath,
                desktop: true,
            },
        });

        return updatedTasks;
    }

    const newTasks = [];

    newTasks.push({
        nodeKey: 'test_live_endpoint',
        title: 'Test live API endpoint',
        instruction: `Send GET request to ${targetUrl} to diagnose current server response and status.`,
        dependencies: [],
        assignedTool: 'httpRequester',
        toolInput: {
            method: 'GET',
            url: targetUrl,
            allowFailure: true,
        },
    });

    newTasks.push({
        nodeKey: 'inspect_server_entry',
        title: 'Inspect server entry file',
        instruction: `Read index.js in ${cleanRelativePath} to inspect existing routes and middleware.`,
        dependencies: ['test_live_endpoint'],
        assignedTool: 'fileManager',
        toolInput: {
            action: 'readDesktopFile',
            path: `${cleanRelativePath}/index.js`,
            desktop: true,
        },
    });

    newTasks.push({
        nodeKey: 'fix_missing_root_route',
        title: 'Add root GET route to server',
        instruction: `Update app.js and index.js in ${cleanRelativePath} to add root GET route (app.get('/', ...)) resolving Express Cannot GET / 404 error.`,
        dependencies: ['inspect_server_entry'],
        assignedTool: 'fileManager',
        toolInput: {
            action: 'createDesktopFile',
            mode: 'update',
            path: `${cleanRelativePath}/app.js`,
            content: `const express = require('express');\nconst app = express();\nlet userRoute;\ntry { userRoute = require('./routes/userRoutes'); } catch (_) {}\n\napp.use(express.json());\n\napp.get('/', (req, res) => {\n  res.status(200).json({\n    status: 'success',\n    message: 'Sample RESTful API is running successfully'\n  });\n});\n\nif (userRoute) app.use(userRoute);\n\nconst PORT = process.env.PORT || 3000;\nif (require.main === module) {\n  app.listen(PORT, () => {\n    console.log(\`Server running on port \${PORT}\`);\n  });\n}\n\nmodule.exports = app;\n`,
            desktop: true,
            overwrite: true,
        },
    });

    newTasks.push({
        nodeKey: 'ensure_index_export',
        title: 'Ensure index entry exports app',
        instruction: `Update index.js in ${cleanRelativePath} to export app for Vercel deployment.`,
        dependencies: ['fix_missing_root_route'],
        assignedTool: 'fileManager',
        toolInput: {
            action: 'createDesktopFile',
            mode: 'update',
            path: `${cleanRelativePath}/index.js`,
            content: `const app = require('./app');\n\nmodule.exports = app;\n`,
            desktop: true,
            overwrite: true,
        },
    });

    if (/vercel\.app/i.test(targetUrl)) {
        newTasks.push({
            nodeKey: 'configure_vercel_routing',
            title: 'Configure Vercel serverless routing',
            instruction: `Create vercel.json in ${cleanRelativePath} to route all incoming requests to Express app.`,
            dependencies: ['ensure_index_export'],
            assignedTool: 'fileManager',
            toolInput: {
                action: 'createDesktopFile',
                mode: 'update',
                path: `${cleanRelativePath}/vercel.json`,
                content: `{\n  "version": 2,\n  "rewrites": [\n    {\n      "source": "/(.*)",\n      "destination": "/app.js"\n    }\n  ]\n}\n`,
                desktop: true,
                overwrite: true,
            },
        });
    }

    const syntaxDep = /vercel\.app/i.test(targetUrl) ? 'configure_vercel_routing' : 'ensure_index_export';

    newTasks.push({
        nodeKey: 'verify_server_syntax',
        title: 'Verify server syntax',
        instruction: 'Verify JavaScript syntax of updated app.js and index.js using node -c.',
        dependencies: [syntaxDep],
        assignedTool: 'executeCommand',
        toolInput: {
            command: 'node -c app.js && node -c index.js',
            cwd: desktopProjectPath,
            desktop: true,
        },
    });

    newTasks.push({
        nodeKey: 'git_stage_changes',
        title: 'Stage modified files',
        instruction: 'Run git add . to stage server route fixes.',
        dependencies: ['verify_server_syntax'],
        assignedTool: 'executeCommand',
        toolInput: {
            command: 'git add .',
            cwd: desktopProjectPath,
            desktop: true,
        },
    });

    const dynamicCommitMsg = generateDynamicCommitMessage(goalPrompt, newTasks);
    newTasks.push({
        nodeKey: 'git_commit_changes',
        title: 'Commit server changes',
        instruction: `Commit server route implementation with message: "${dynamicCommitMsg}".`,
        dependencies: ['git_stage_changes'],
        assignedTool: 'executeCommand',
        toolInput: {
            command: `git commit -m "${dynamicCommitMsg}"`,
            cwd: desktopProjectPath,
            desktop: true,
        },
    });

    newTasks.push({
        nodeKey: 'git_branch_main',
        title: 'Set default branch to main',
        instruction: 'Ensure branch is named main before pushing.',
        dependencies: ['git_commit_changes'],
        assignedTool: 'executeCommand',
        toolInput: {
            command: 'git branch -M main',
            cwd: desktopProjectPath,
            desktop: true,
        },
    });

    newTasks.push({
        nodeKey: 'git_push_deploy',
        title: 'Push changes to deploy',
        instruction: 'Push commit to remote repository to trigger live deployment.',
        dependencies: ['git_branch_main'],
        assignedTool: 'executeCommand',
        toolInput: {
            command: 'git push origin main',
            cwd: desktopProjectPath,
            desktop: true,
        },
    });

    return newTasks;
};

const normalizeGitPushWorkflowTasks = (tasks, goalPrompt, localDestination) => {
    const text = String(goalPrompt || '').trim();
    if (!text) return tasks;

    const isGitPushIntent = /\b(?:push|deploy|publish)\b.*\b(?:github|git|remote|origin|repo)\b/i.test(text)
        || /\b(?:git\s+push|push\s+to\s+github|deploy\s+to\s+github|push\s+code)\b/i.test(text)
        || /^[\s\w]*push[\s\w]*github[\s\w]*$/i.test(text);

    if (!isGitPushIntent) return tasks;

    let projectPath = null;
    const dest = normalizeLocalDestination(localDestination);
    if (dest?.relativePath) {
        projectPath = dest.relativePath;
    } else {
        for (const t of tasks) {
            const candidate = t.toolInput?.cwd || t.toolInput?.path;
            if (typeof candidate === 'string' && candidate.toLowerCase().includes('sample-res-tful-api')) {
                projectPath = candidate.replace(/^desktop[\\/]+/i, '').replace(/[\\/]+$/, '');
                break;
            }
        }
        if (!projectPath) {
            projectPath = 'Api-Productions/Sample-RESTful-API-';
        }
    }

    const desktopProjectPath = `Desktop/${projectPath.replace(/^desktop[\\/]+/i, '')}`;

    return [
        {
            nodeKey: 'git_status_check',
            title: 'Check repository status',
            instruction: 'Check git status in the project directory to inspect modified and untracked files.',
            dependencies: [],
            assignedTool: 'executeCommand',
            toolInput: {
                command: 'git status',
                cwd: desktopProjectPath,
                desktop: true,
            },
        },
        {
            nodeKey: 'git_stage_changes',
            title: 'Stage modified files',
            instruction: 'Run git add . to stage all project files for commit.',
            dependencies: ['git_status_check'],
            assignedTool: 'executeCommand',
            toolInput: {
                command: 'git add .',
                cwd: desktopProjectPath,
                desktop: true,
            },
        },
        {
            nodeKey: 'git_commit_changes',
            title: 'Commit changes',
            instruction: 'Commit staged changes to prepare for deployment.',
            dependencies: ['git_stage_changes'],
            assignedTool: 'executeCommand',
            toolInput: {
                command: `git commit -m "${generateDynamicCommitMessage(goalPrompt, tasks)}"`,
                cwd: desktopProjectPath,
                desktop: true,
            },
        },
        {
            nodeKey: 'git_branch_main',
            title: 'Set default branch to main',
            instruction: 'Ensure branch is named main for GitHub compatibility.',
            dependencies: ['git_commit_changes'],
            assignedTool: 'executeCommand',
            toolInput: {
                command: 'git branch -M main',
                cwd: desktopProjectPath,
                desktop: true,
            },
        },
        {
            nodeKey: 'git_push_deploy',
            title: 'Push changes to deploy',
            instruction: 'Push commit to remote repository to trigger live deployment.',
            dependencies: ['git_branch_main'],
            assignedTool: 'executeCommand',
            toolInput: {
                command: 'git push origin main',
                cwd: desktopProjectPath,
                desktop: true,
            },
        },
    ];
};

const clampPlannerText = (value, maxLength, fallback) => {
    const text = String(value ?? '').trim();
    let clamped = text.slice(0, maxLength);
    const lastCodeUnit = clamped.charCodeAt(clamped.length - 1);
    if (lastCodeUnit >= 0xD800 && lastCodeUnit <= 0xDBFF) {
        clamped = clamped.slice(0, -1);
    }
    clamped = clamped.trim();
    return clamped || fallback;
};

const normalizePlan = (rawPlan, {goalPrompt = '', localDestination = ''} = {}) => {
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

        // A rename request is a single-target operation that preserves the
        // source directory contents and must not be interpreted as deletion.
        plan.tasks = normalizeRenamePlan(plan.tasks, goalPrompt);
        // A destructive request is a single-target operation. Replace any
        // model-added create, export, or setup tasks so removal never causes
        // unrelated files such as index.js to be created.
        plan.tasks = normalizeRemovalPlan(plan.tasks, goalPrompt, localDestination);

        // The executor rejects shell chaining. Expand planner output such as
        // `php --version && composer --version` into ordered command tasks.
        plan.tasks = normalizeChainedCommandTasks(plan.tasks);
        // Verification must come from the user's prompt. Do not let the model
        // invent an ESLint task that the generated project cannot support.
        plan.tasks = normalizePromptVerificationTasks(plan.tasks, goalPrompt);
        // Preparation/cleanup requests must not inherit build, test, or lint
        // tasks merely because the existing project happens to contain Vue or
        // another framework. Inspect first and wait for an explicit command
        // request before running project verification.
        plan.tasks = normalizeProjectPreparationTasks(plan.tasks, goalPrompt);

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
        // Explicit Desktop requests are already delivered locally. Remove any
        // model-added Downloads/Desktop export that would duplicate the output.
        plan.tasks = normalizeLocalExportTasks(plan.tasks, goalPrompt);
        // Vue/Vite project setup requires commands to run inside the requested Desktop folder.
        // The LLM plan may otherwise downgrade the request to a folder-only or file-only task.
        plan.tasks = ensureVueDesktopProjectTasks(plan.tasks, goalPrompt);
        // Node.js project setup needs the same deterministic treatment as Vue projects.
        // This prevents an LLM plan from creating only an empty src/node.js file and
        // guarantees an idempotent MVC + Service structure on the requested Desktop path.
        plan.tasks = ensureNodeDesktopProjectTasks(plan.tasks, goalPrompt);
        // An explicit project tree is an acceptance contract. Preserve every
        // requested path and create its directory tasks dynamically from the
        // user's tree instead of relying on a fixed architecture template.
        plan.tasks = ensureExplicitProjectTreeDirectories(plan.tasks, goalPrompt);
        // Pinia follow-up requests must execute inside the existing Desktop Vue project.
        // Normalize common misspellings such as "Pinai" to the real package and setup.
        plan.tasks = ensurePiniaDesktopProjectTasks(plan.tasks, goalPrompt);
        // Vue/Node normalization can convert workspace file tasks into direct Desktop
        // writes after the first export pass. Re-check here so a stale
        // exportWorkspaceToDesktop task cannot copy into an already-existing project
        // directory and fail with EEXIST after the direct files were written.
        plan.tasks = normalizeLocalExportTasks(plan.tasks, goalPrompt);
        // Desktop asset discovery must use the constrained fileManager path, never a shell command.
        plan.tasks = normalizeDesktopAssetTasks(plan.tasks, goalPrompt);
        plan.tasks = normalizeImageTasks(plan.tasks, goalPrompt);
        plan.tasks = ensureRequestedHtmlTask(plan.tasks, goalPrompt);
        // A Vue/Vite build requires a root index.html entry point. Add a safe,
        // skip-if-present task before build verification when it is missing.
        plan.tasks = ensureVueEntryPointTask(plan.tasks, goalPrompt);
        // Vue source files require the official Vite plugin. Add the dependency
        // and a safe, skip-if-present vite.config.js task before build verification.
        plan.tasks = ensureVueBuildToolingTasks(plan.tasks, goalPrompt);
        // Re-running a Desktop project setup must be safe and resumable. Existing files are
        // preserved and reported as skipped unless the user explicitly asks to update/overwrite.
        plan.tasks = normalizeIdempotentDesktopSetupTasks(plan.tasks, goalPrompt);
        // Explicit existing-project updates must not fail with EEXIST. Convert generated
        // file writes to update semantics while preserving existing files when content is empty.
        plan.tasks = normalizeExistingProjectUpdateTasks(plan.tasks, goalPrompt);
        // Architecture follow-ups must materialize the requested MVC + Service
        // boundaries instead of collapsing them into one empty `src` folder.
        // Existing Desktop projects are updated in place, so no workspace
        // export is needed for these directory tasks.
        plan.tasks = ensureRequestedArchitectureDirectories(plan.tasks, goalPrompt);
        // Local development users should be able to open the generated project in Finder.
        plan.tasks = appendDesktopExportTask(plan.tasks, goalPrompt, localDestination);
        // File-producing workflows without an explicit destination are downloaded locally by default.
        plan.tasks = appendDownloadsExportTask(plan.tasks, goalPrompt);
        // Clean up redundant directory structures for existing projects in-place without exporting
        plan.tasks = normalizeStructureCleanupTasks(plan.tasks, goalPrompt, localDestination);
        // Autonomous server review and repair: ensure URL modify/fix requests include diagnosis, route fix, syntax check, and git commit/push
        plan.tasks = normalizeServerReviewAndFixTasks(plan.tasks, goalPrompt, localDestination);
        // Dedicated git push workflow: ensure standalone push to github requests always have complete status, stage, commit, branch, and push
        plan.tasks = normalizeGitPushWorkflowTasks(plan.tasks, goalPrompt, localDestination);
        // Ensure Git commits use dynamic semantic commit messages
        plan.tasks = normalizeGitCommitTasks(plan.tasks, goalPrompt);
        // Ensure Git pushes always rename default branch to main
        plan.tasks = normalizeGitBranchTasks(plan.tasks);

        if (isRenameRequest(goalPrompt) && plan.tasks.length === 1) {
            const renamePaths = extractRenamePaths(goalPrompt);
            if (renamePaths) {
                plan.workflowTitle = `Rename Desktop/${renamePaths.sourcePath} to Desktop/${renamePaths.targetPath}`;
                plan.summary = `Rename the Desktop folder ${renamePaths.sourcePath} to ${renamePaths.targetPath} without deleting or overwriting its contents.`;
            }
        } else if (isRemovalRequest(goalPrompt) && plan.tasks.length === 1) {
            const targetPath = extractRemovalTarget(goalPrompt);
            if (targetPath) {
                plan.workflowTitle = `Remove ${targetPath}`;
                plan.summary = `Remove only the requested target ${targetPath}.`;
            }
        }

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

    // Keep planner-generated metadata within the same limits used by the
    // workflow and task database columns. LLMs can echo the entire user goal
    // into a title even though the plan schema requires a short label.
    plan.workflowTitle = clampPlannerText(plan.workflowTitle, 255, 'Workflow Plan');
    plan.summary = clampPlannerText(plan.summary, 5000, 'Execution plan');
    plan.tasks = Array.isArray(plan.tasks)
        ? plan.tasks.map((task, index) => ({
            ...task,
            title: clampPlannerText(task.title, 255, `Task ${index + 1}`),
            instruction: clampPlannerText(
                task.instruction || task.description || task.title,
                10000,
                `Execute task ${index + 1}.`,
            ),
        }))
        : plan.tasks;

    return plan;
};

const getMissingProjectTreeFiles = (plan, goalPrompt) => {
    if (!isNodeProjectSetupRequest(goalPrompt)) {
        return [];
    }

    const layout = extractProjectTreeLayout(goalPrompt);
    if (!layout.files.length) {
        return [];
    }

    const projectRoot = cleanRelativeDirectoryPath(
        inferDirectoryPath({title: '', instruction: ''}, {}, goalPrompt),
    );
    if (!projectRoot) {
        return [];
    }

    const generatedFiles = new Map();
    for (const task of Array.isArray(plan?.tasks) ? plan.tasks : []) {
        for (const entry of getProjectFileEntries(task)) {
            const canonicalPath = canonicalizeProjectPath(entry.path, projectRoot);
            if (canonicalPath) {
                const key = canonicalPath.toLowerCase();
                generatedFiles.set(
                    key,
                    Boolean(generatedFiles.get(key) || hasGeneratedFileContent(entry.content)),
                );
            }
        }
    }

    return layout.files
        .map((relativePath) => `${projectRoot}/${relativePath}`)
        .filter((filePath) => !generatedFiles.get(filePath.toLowerCase()));
};

const resolveCompletionFilePath = (value, requestedPaths, projectRoot) => {
    const rawValue = typeof value === 'string'
        ? value.trim().replace(/^['"`]|['"`]$/g, '').replace(/\\/g, '/')
        : '';
    const cleanRoot = cleanRelativeDirectoryPath(projectRoot);
    if (!rawValue || !cleanRoot) {
        return null;
    }

    const rootSegments = cleanRoot.split('/').filter(Boolean);
    const rawSegments = rawValue.split('/').filter(Boolean);
    const desktopIndex = rawSegments.findIndex((segment) => segment.toLowerCase() === 'desktop');
    let canonicalPath = null;

    // Models sometimes echo the user's absolute Desktop path. Accept it only
    // when it contains this exact requested project root, then discard the
    // host-specific prefix before matching against the requested file list.
    if (desktopIndex >= 0) {
        const returnedRoot = rawSegments.slice(desktopIndex + 1, desktopIndex + 1 + rootSegments.length);
        const rootMatches = returnedRoot.length === rootSegments.length
            && rootSegments.every((segment, index) => segment.toLowerCase() === returnedRoot[index].toLowerCase());
        if (!rootMatches) {
            return null;
        }

        const suffix = rawSegments.slice(desktopIndex + 1 + rootSegments.length);
        if (!suffix.length) {
            return null;
        }
        canonicalPath = [...rootSegments, ...suffix].join('/');
    } else {
        const rawPath = cleanRelativeFilePath(rawValue);
        if (!rawPath) {
            return null;
        }
        canonicalPath = canonicalizeProjectPath(rawPath, cleanRoot) || rawPath;
    }

    const candidatePath = canonicalPath.toLowerCase();
    const exactMatch = requestedPaths.find((filePath) => filePath.toLowerCase() === candidatePath);
    if (exactMatch) {
        return exactMatch;
    }

    // Some models return only `fileName` (or a path relative to the project
    // root) even when the prompt contains a nested path. Resolve that output
    // only when it maps to one requested file; ambiguous basenames remain
    // rejected so content cannot be written to the wrong file.
    const suffixMatches = requestedPaths.filter((filePath) => {
        const requestedPath = filePath.toLowerCase();
        return requestedPath.endsWith(`/${candidatePath}`)
            || path.basename(requestedPath) === path.basename(candidatePath);
    });

    return suffixMatches.length === 1 ? suffixMatches[0] : null;
};

const normalizeCompletionFileRecord = (record, fallbackPath = null) => {
    if (typeof record === 'string') {
        return typeof fallbackPath === 'string' && record.trim()
            ? {path: fallbackPath, content: record}
            : null;
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
        return null;
    }

    const filePath = record.path
        || record.filePath
        || record.fileName
        || record.filename
        || record.name
        || fallbackPath;
    const content = record.content
        ?? record.contents
        ?? record.fileContent
        ?? record.code
        ?? record.source
        ?? record.body;

    return typeof filePath === 'string' && typeof content === 'string' && content.trim()
        ? {path: filePath, content}
        : null;
};

const getCompletionFileEntries = (data, requestedBatch) => {
    const fallbackPath = requestedBatch.length === 1 ? requestedBatch[0] : null;
    const entries = [];
    const addCollection = (collection) => {
        if (Array.isArray(collection)) {
            for (const record of collection) {
                const entry = normalizeCompletionFileRecord(record, fallbackPath);
                if (entry) entries.push(entry);
            }
            return;
        }

        if (collection && typeof collection === 'object') {
            for (const [filePath, record] of Object.entries(collection)) {
                const entry = normalizeCompletionFileRecord(record, filePath || fallbackPath);
                if (entry) entries.push(entry);
            }
        }
    };

    if (Array.isArray(data)) {
        addCollection(data);
    } else if (data && typeof data === 'object') {
        for (const key of ['files', 'generatedFiles', 'fileContents', 'outputs']) {
            if (data[key] !== undefined) {
                addCollection(data[key]);
            }
        }

        for (const task of Array.isArray(data.tasks) ? data.tasks : []) {
            const input = task?.toolInput || task?.input || task || {};
            const collections = ['files', 'generatedFiles', 'fileContents']
                .filter((key) => input[key] !== undefined);
            if (collections.length > 0) {
                for (const key of collections) addCollection(input[key]);
            } else {
                const entry = normalizeCompletionFileRecord(input, fallbackPath)
                    || normalizeCompletionFileRecord(task, fallbackPath);
                if (entry) entries.push(entry);
            }
        }
    }

    return entries;
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

    const missingProjectFiles = getMissingProjectTreeFiles(plan, options.goalPrompt || '');
    if (missingProjectFiles.length > 0) {
        const listedFiles = missingProjectFiles.slice(0, 20).join(', ');
        const suffix = missingProjectFiles.length > 20
            ? `, and ${missingProjectFiles.length - 20} more`
            : '';

        return {
            success: false,
            error: {
                message: `The plan is incomplete. Include every file from the user's explicit project tree with complete file content. Missing: ${listedFiles}${suffix}`,
            },
        };
    }

    return {
        success: true,
        data: plan,
    };
};

const completeExplicitProjectTreePlan = async ({
    basePlan,
    goalPrompt,
    runId,
    io,
    generateStructure = generateStructureClient,
}) => {
    const projectRoot = cleanRelativeDirectoryPath(
        inferDirectoryPath({title: '', instruction: ''}, {}, goalPrompt),
    );
    if (!projectRoot) {
        throw new Error('Unable to determine the requested Desktop project directory for file completion.');
    }

    const completionSystemPrompt = `
You are KAIRO's source-file completion planner.
Generate complete production-quality source/configuration/documentation content for ONLY the exact file paths listed by the user.
Return ONLY valid JSON in this shape: {"files":[{"path":"exact requested path","content":"complete file contents"}]}.
Return exactly one files entry per requested path, with a non-empty content string.
Do not return directory tasks, shell commands, placeholders, TODOs, or files that were not requested.
Preserve the requested runtime, dependencies, security requirements, database behavior, and architecture.
Escape literal backslashes correctly for JSON.
`.trim();

    let workingPlan = normalizePlan(basePlan, {goalPrompt});
    let missingFiles = getMissingProjectTreeFiles(workingPlan, goalPrompt);
    let stalledBatches = 0;
    const treeFileCount = extractProjectTreeLayout(goalPrompt).files.length;
    const maxBatches = Math.min(96, Math.max(24, Math.ceil(treeFileCount / 3) * 2));
    const maxParallelBatches = 3;
    const configuredCompletionTimeout = Number(process.env.LLM_FILE_COMPLETION_TIMEOUT_MS);
    const configuredPlannerTimeout = Number(process.env.LLM_TIMEOUT_MS);
    const completionTimeoutMs = Number.isInteger(configuredCompletionTimeout)
        && configuredCompletionTimeout >= 5000
        ? Math.min(configuredCompletionTimeout, 60000)
        : Number.isInteger(configuredPlannerTimeout) && configuredPlannerTimeout >= 5000
            ? Math.min(configuredPlannerTimeout, 60000)
            : 30000;
    let batchesStarted = 0;

    while (missingFiles.length > 0 && batchesStarted < maxBatches) {
        // Large trees need grouped responses to stay within the finite call
        // budget. If an entire round makes no progress, reduce to one file per
        // call to recover from truncation or a malformed multi-file response.
        const batchSize = stalledBatches > 0 ? 1 : 3;
        const isRecoveryPass = stalledBatches > 0;
        const batches = [];
        for (let offset = 0; offset < missingFiles.length && batches.length < maxParallelBatches; offset += batchSize) {
            batches.push(missingFiles.slice(offset, offset + batchSize));
        }
        const remainingBatchSlots = maxBatches - batchesStarted;
        const selectedBatches = batches.slice(0, remainingBatchSlots);
        const completionResults = await Promise.allSettled(selectedBatches.map((batch) => {
            const completionPrompt = `Original user goal:\n${goalPrompt}\n\nGenerate complete file contents for ONLY these exact missing paths:\n${batch
                .map((filePath) => `- ${filePath}`)
                .join('\n')}\n\nReturn one files entry per path in the requested JSON shape. Do not omit any path in this batch.`;

            return generateStructure({
                systemPrompt: completionSystemPrompt,
                userPrompt: completionPrompt,
                runId,
                io,
                maxModelAttempts: 2,
                maxTransientRetries: 1,
                timeoutMs: isRecoveryPass
                    ? Math.min(Math.max(completionTimeoutMs, 30000), 60000)
                    : completionTimeoutMs,
                maxOutputTokens: 16000,
            });
        }));
        batchesStarted += selectedBatches.length;

        const completionTasks = [];
        const addedCompletionPaths = new Set();
        let addedFiles = 0;

        completionResults.forEach((result, resultIndex) => {
            if (result.status !== 'fulfilled') {
                console.warn(
                    `⚠️ [Planner] File completion batch ${resultIndex + 1}/${completionResults.length} failed:`,
                    result.reason?.message || result.reason,
                );
                return;
            }

            const completionResult = result.value;
            const requestedBatch = selectedBatches[resultIndex];
            const fileEntries = getCompletionFileEntries(completionResult.data, requestedBatch);
            let acceptedBatchFiles = 0;

            for (const entry of fileEntries) {
                if (!hasGeneratedFileContent(entry.content)) {
                    continue;
                }

                const requestedPath = resolveCompletionFilePath(
                    entry.path,
                    requestedBatch,
                    projectRoot,
                );
                if (!requestedPath
                    || addedCompletionPaths.has(requestedPath.toLowerCase())) {
                    continue;
                }

                addedCompletionPaths.add(requestedPath.toLowerCase());

                completionTasks.push({
                    nodeKey: getUniqueNodeKey([
                        ...(Array.isArray(workingPlan.tasks) ? workingPlan.tasks : []),
                        ...completionTasks,
                    ], `complete_${path.basename(requestedPath).replace(/[^A-Za-z0-9]+/g, '_').toLowerCase()}`),
                    title: `Create ${requestedPath}`,
                    instruction: `Create ${requestedPath} with the complete implementation requested by the user.`,
                    dependencies: [],
                    assignedTool: 'fileManager',
                    toolInput: {
                        action: 'createDesktopFile',
                        mode: 'create',
                        path: requestedPath,
                        content: entry.content,
                    },
                });
                addedFiles += 1;
                acceptedBatchFiles += 1;
            }

            if (acceptedBatchFiles === 0) {
                console.warn(
                    `⚠️ [Planner] File completion batch ${resultIndex + 1}/${completionResults.length} `
                    + `returned ${fileEntries.length} usable record(s), but none matched its `
                    + `${requestedBatch.length} requested path(s). Response keys: `
                    + `${Object.keys(completionResult.data || {}).join(', ') || '(none)'}`,
                );
            }
        });

        const previousMissingCount = missingFiles.length;
        workingPlan = normalizePlan({
            ...workingPlan,
            tasks: [
                ...(Array.isArray(workingPlan.tasks) ? workingPlan.tasks : []),
                ...completionTasks,
            ],
        }, {goalPrompt});
        missingFiles = getMissingProjectTreeFiles(workingPlan, goalPrompt);

        if (!addedFiles || missingFiles.length >= previousMissingCount) {
            stalledBatches += 1;
        } else {
            stalledBatches = 0;
        }

        if (stalledBatches >= 2) {
            break;
        }
    }

    if (missingFiles.length > 0) {
        const listedFiles = missingFiles.slice(0, 20).join(', ');
        const suffix = missingFiles.length > 20
            ? `, and ${missingFiles.length - 20} more`
            : '';
        throw new Error(`Unable to complete the explicit project tree. Missing generated files: ${listedFiles}${suffix}`);
    }

    return workingPlan;
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
    if (!value) return null;
    let raw = typeof value === 'object'
        ? String(value.workspacePath || value.name || value.path || '').trim()
        : String(value || '').trim();
    raw = raw.replace(/\\/g, '/').replace(/^['"`]|['"`]$/g, '');

    // Strip trailing instruction context if present
    raw = raw
        .split(/\.\s*Create or update/i)[0]
        .split(/\s*\[Follow-up/i)[0]
        .split(/\.\s*Do not choose/i)[0]
        .trim();

    // Strip leading home/tilde or absolute desktop/downloads path
    raw = raw.replace(/^.*?\/(Desktop|Downloads)\//i, '$1/');
    raw = raw.replace(/^~[\\/]+/i, '');

    const match = raw.match(/^(desktop|downloads?)\/(.+)$/i);
    if (match) {
        const location = /^downloads?$/i.test(match[1]) ? 'Downloads' : 'Desktop';
        const relativePath = cleanRelativeDirectoryPath(match[2].replace(/[.,;!?]+$/, ''));
        if (relativePath) {
            return {location, relativePath};
        }
    }

    // Bare project name or relative path like "smart-parking-system"
    const cleaned = cleanRelativeDirectoryPath(raw.replace(/^[\\/]+/, '').replace(/[.,;!?]+$/, ''));
    if (cleaned && !['api', 'v1', 'the', 'my', 'a', 'this', 'run'].includes(cleaned.toLowerCase())) {
        return {location: 'Desktop', relativePath: cleaned};
    }

    return null;
};

const findMatchingDesktopProject = async (goalPrompt) => {
    if (!LOCAL_DESKTOP_OUTPUT_ENABLED) return null;
    const text = String(goalPrompt || '').trim();
    if (!text) return null;

    // 1. Extract potential project names from URLs in the prompt (e.g. sample-res-tful-api)
    const urlMatches = text.match(/https?:\/\/([a-z0-9_-]+)(?:\.[a-z0-9_-]+)*\.[a-z]{2,}/gi) || [];
    const candidates = [];

    for (const urlStr of urlMatches) {
        try {
            const parsed = new URL(urlStr);
            const hostParts = parsed.hostname.split('.');
            if (hostParts.length >= 2) {
                candidates.push(hostParts[0]);
            }
        } catch (_) {}
    }

    const words = text.match(/[a-zA-Z0-9_-]{3,}/g) || [];
    candidates.push(...words);

    const normalize = (str) => String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const desktopRoot = path.join(os.homedir(), 'Desktop');

    try {
        const topEntries = await fs.readdir(desktopRoot, {withFileTypes: true});
        const directories = [];

        for (const entry of topEntries) {
            if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
            directories.push({relativePath: entry.name, name: entry.name});

            // Also check 1 level deep inside category folders (e.g. Api-Productions, projects, etc.)
            if (['api-productions', 'projects', 'apps', 'code', 'apis', 'services', 'servers'].includes(entry.name.toLowerCase()) || entry.name.includes('-')) {
                try {
                    const subDir = path.join(desktopRoot, entry.name);
                    const subEntries = await fs.readdir(subDir, {withFileTypes: true});
                    for (const sub of subEntries) {
                        if (sub.isDirectory() && !sub.name.startsWith('.')) {
                            directories.push({
                                relativePath: `${entry.name}/${sub.name}`,
                                name: sub.name,
                            });
                        }
                    }
                } catch (_) {}
            }
        }

        for (const candidate of candidates) {
            const candNorm = normalize(candidate);
            if (!candNorm || candNorm.length < 3) continue;

            for (const dir of directories) {
                const dirNorm = normalize(dir.name);
                if (dirNorm === candNorm || (candNorm.length >= 6 && (dirNorm.includes(candNorm) || candNorm.includes(dirNorm)))) {
                    return `Desktop/${dir.relativePath}`;
                }
            }
        }
    } catch (_) {}

    return null;
};

const buildPlanningGoalPrompt = (goalPrompt, localDestination) => {
    const destination = normalizeLocalDestination(localDestination);
    if (!destination) return goalPrompt;

    return `${goalPrompt}\n\n[Follow-up execution context: Target local folder is "${destination.location}/${destination.relativePath}". Work inside this project directory.]`;
};

const planWorkflowRun = async ({
    runId,
    goalPrompt,
    images = [],
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

    let effectiveDestination = localDestination;
    const urlMatches = String(goalPrompt || '').match(/https?:\/\/([a-z0-9_-]+)/i);
    if (urlMatches) {
        const urlDomain = urlMatches[1].toLowerCase().replace(/[^a-z0-9]/g, '');
        const destNorm = String(localDestination || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        // If localDestination does not match the URL domain, ignore it and search Desktop
        if (!destNorm || (!destNorm.includes(urlDomain) && !urlDomain.includes(destNorm))) {
            const matchedProject = await findMatchingDesktopProject(goalPrompt);
            if (matchedProject) {
                effectiveDestination = matchedProject;
            }
        }
    } else if (!effectiveDestination) {
        effectiveDestination = await findMatchingDesktopProject(goalPrompt);
    }
    const planningGoalPrompt = buildPlanningGoalPrompt(goalPrompt, effectiveDestination);
    const cacheKey = getCacheKey(planningGoalPrompt);
    let validatedPlan = null;

    if (planCache.has(cacheKey)) {
        console.log(`⚡ [Planner Cache Hit] Reusing validated DAG plan for goal: "${goalPrompt}"`);
        const cached = planCache.get(cacheKey);
        validatedPlan = normalizePlan(JSON.parse(JSON.stringify(cached)), {
            goalPrompt: planningGoalPrompt,
            localDestination: effectiveDestination,
        });
    }

    if (!validatedPlan) {
        const desktopInstruction = LOCAL_DESKTOP_OUTPUT_ENABLED
            ? `- Local file output is enabled for development. For a request to create a folder directly on the Mac Desktop, use fileManager with {"action":"createDesktopDirectory","path":"requested-folder"}. For a request to rename a Desktop folder, use exactly one fileManager task with {"action":"renameDesktopPath","path":"source-folder","destination":"target-folder","kind":"directory"}; preserve contents and never convert it into a delete task. For a project setup inside that folder, first create the folder with fileManager, then use executeCommand with a relative cwd and desktop:true for the approved package-manager command. To list local assets, use fileManager with {"action":"listDesktopDirectory","path":"requested-folder","imagesOnly":true}; to export a completed project for Finder, use fileManager with {"action":"exportWorkspaceToDesktop","path":"requested-folder"}. For a local Downloads request, use fileManager with {"action":"exportWorkspaceToDownloads","path":"requested-folder"}. If a file-producing workflow does not specify a destination, add exportWorkspaceToDownloads as the final task so the result is available under ~/Downloads/kairo-workflow. Never use executeCommand to create a Desktop directory or to access arbitrary absolute local paths.`
            : '- Host Desktop output is disabled. Use fileManager action createDirectory with a relative path inside the workflow workspace; never target a host Desktop.';
        const explicitTreeFiles = extractProjectTreeLayout(planningGoalPrompt).files;
        const largeTreeInstruction = isNodeProjectSetupRequest(planningGoalPrompt)
            && explicitTreeFiles.length >= 12
            ? '- For a large explicit project tree, keep the initial plan compact: create the requested directory tasks and at most three representative file tasks. Do not emit every source file in this initial response; a bounded completion stage will add complete content for every exact requested file path.'
            : '';
        const systemPrompt = `
You are KAIRO, an autonomous AI workflow planner.
Decompose the user goal into a Directed Acyclic Graph (DAG) of executable subtasks.
Available Tools:
1. 'executeCommand' - Run one allowlisted workspace command at a time, such as cat, head, tail, grep, ls, pwd, find, wc, python, python3, pip, pip3, pytest, php, composer, mvn, go, npm, npx, node, and git. For Python projects with a virtual environment, run package operations through the project-local interpreter, for example './venv/bin/python -m pip install -r requirements.txt'. Never replace that with system pip or '--break-system-packages'. Never invent commands such as 'check' or 'list'. For file inspection, prefer fileManager with action 'read' or 'list' so the exact path and filename case are preserved. Never use shell chaining (&&, ||, or ;), pipes, redirects, subshells, or newlines. If multiple commands are needed, create separate dependent executeCommand tasks. Never use executeCommand or mkdir for directory creation; use fileManager instead.
2. 'fileManager' - Create, edit, read, list, delete, or rename files and folders, create workspace directories, access a local Desktop directory, or export a completed workspace to the local Desktop or Downloads when explicitly enabled. Use {"action":"createDirectory","path":"relative/directory"} for workspace directories, {"action":"listDesktopDirectory","path":"requested-folder","imagesOnly":true} to list local Desktop image assets, {"action":"deleteDesktopPath","path":"requested-folder"} for an explicit local Desktop removal request, {"action":"renameDesktopPath","path":"source-folder","destination":"target-folder","kind":"directory"} only for an explicit rename/move request, {"action":"exportWorkspaceToDesktop","path":"requested-folder"} for explicit Desktop output, and {"action":"exportWorkspaceToDownloads","path":"requested-folder"} for local Downloads output.
3. 'webSearch' - Query DuckDuckGo; set toolInput.scrape=true when page HTML should be converted to Markdown.
4. 'databaseConnector' - Execute parameterized SQL with toolInput.sql and toolInput.params.
5. 'httpRequester' - Make HTTP/HTTPS API calls with toolInput.method, url, headers, params, and data.
6. 'sshRequester' - Run one approved command on a configured SSH target. Use toolInput.target as a configured alias, toolInput.command as one simple command, and optional toolInput.cwd as the remote working directory. Never put passwords, private keys, host overrides, or credentials in toolInput. SSH tasks always require HITL approval; do not use SSH for local workspace commands.
7. 'imageGenerator' - Generate images, UI mockups, banners, or logos with toolInput.prompt, toolInput.fileName, toolInput.aspectRatio ('1:1', '16:9', '9:16', '4:3', '3:4'), and optional toolInput.outputMode ('file', 'url', or 'both').

Rules:
- Assign dependencies logically (for example, task_2 depends on ['task_1']).
- Never create circular dependencies.
- Every dependency must reference an existing nodeKey.
- Never use an absolute path or a path containing '..'. The executor enforces either the workspace boundary or the explicitly enabled local Desktop boundary.
- For regular directory creation, prefer the fileManager tool with action 'createDirectory'.
- When the user requests to create or add a folder or directory (e.g. "add folder validator", "create directory utils", "add folder components"), create that directory task using fileManager with action 'createDirectory' (or 'createDesktopDirectory' for local Desktop projects). Do NOT convert a folder creation request into a JavaScript/code file (such as folderValidator.js) unless the user explicitly requested code or a file.
- CRITICAL PROJECT STRUCTURE RULE: If a project organizes its source code (e.g., controllers/, routes/, models/, services/, validation/) directly at the project root without a 'src/' folder, NEVER create, prefix, or invent a 'src/' directory. Create all new directories, schemas, validators, routes, and files directly at the project root or inside their existing parent root folders (e.g., <project>/validation/schema, <project>/routes, <project>/controllers). Only use 'src/' if the target project already contains an existing 'src/' folder (like in Vite or React projects).
- When creating or adding a folder (e.g. "add folder schema", "add folder validation", "create directory utils"): Place the folder directly at the project root or inside the named parent folder. NEVER invent artificial folder chains like 'src/desktops/', and NEVER arbitrarily insert a 'src/' folder prefix.
- When an active local project context is provided or implied, anchor all generated files, directories, and exports inside that active project folder. Never export or divert files to an arbitrary top-level folder like Desktop/view or Desktop/src.
- For an explicit Desktop folder rename or move, create exactly one fileManager task with action 'renameDesktopPath', a relative source path, and a relative destination path. Preserve the source contents; never add a delete task or interpret words such as 'do not delete' as a removal request.
- Never assign executeCommand to a directory or folder creation task. For a local Desktop project setup, it is valid to run the project scaffolding and dependency-install commands with a relative Desktop cwd after the directory task succeeds.
- For an explicit remove or delete request, create exactly one fileManager task targeting only the named path. Use deleteDesktopPath for a local Desktop target. Do not add create-file, project-setup, or export tasks to a removal workflow.
- For requests to generate a visual image, logo, icon, banner, illustration, or artwork, assign imageGenerator. Do not answer with a textual design description or use fileManager to create an SVG unless the user explicitly requests source code.
- When the user asks to "add file <filename>" (e.g. "add file main.java", "add file app.js", "create file"), this means CREATE/WRITE a new file using fileManager. Do NOT run git add, git commit, or execute git commands for file creation requests unless the user explicitly requested Git/GitHub operations.
- STRICT DEPLOYMENT & VERCEL RULE: NEVER generate 'vercel.json', 'api/index.js', or serverless deployment configurations unless the user explicitly and directly asks to deploy to Vercel or fix a Vercel deployment (e.g. "deploy to vercel", "fix vercel deployment"). For normal feature development, coding, adding files, building applications, or working in existing projects, NEVER create, modify, or delete vercel.json or api/index.js.
- For Git and GitHub requests (e.g. "git init", "commit", "push this project to github", "create repo on github"): ALWAYS set cwd to the top-level project root folder (e.g. Desktop/<project> with desktop: true). Never set cwd to an internal subfolder. The workflow should initialize Git if needed (git init), stage files (git add .), and commit changes (git commit -m "feat: initial commit"). When pushing to GitHub, check or configure the remote origin URL on main branch (git push -u origin main).
- When the user provides a deployment or API URL (e.g. https://... or .vercel.app) and asks to review, test, or modify the URL or server: NEVER bind or modify an unrelated local project (such as Blockchain or any previous project) unless the user explicitly named that project or context matches. NEVER use executeCommand to 'grep' for the deployment domain string across the codebase (e.g. do NOT run 'grep -rn sample-res-tful-api.vercel.app .'); remote hostnames are hosted externally and will never exist inside local source files. To test or review the live endpoint, use 'httpRequester' with method 'GET' and toolInput.allowFailure=true. When the prompt also asks to modify or fix the server: if a target project folder is provided or matched (e.g. on Desktop), plan subsequent steps to inspect the server entry files (app.js, server.js, index.js), add or fix the missing route (such as adding app.get('/', ...) to resolve Express 'Cannot GET /' 404 errors), and verify syntax with node -c. If no local code exists or only the live URL is tested, report the root-cause diagnosis clearly.
- When asked to inspect, profile, or calculate remote server resources (CPU, RAM, storage, disk, or memory usage): For a configured remote target, plan diagnostic tasks using 'sshRequester' (e.g. command 'free -m' for RAM, 'df -hT' for storage, 'lscpu' for CPU cores, or 'uptime' for load average) to collect accurate server hardware telemetry.
- Never add '|| true', '|| exit 0', redirects, or chained operators to executeCommand commands; keep every command as a single clean executable command.
- Use imageGenerator only for visual image, logo, icon, banner, illustration, or artwork generation. Never use it for HTML, JSON, CSS, JavaScript, metadata, project structure, file creation, or asset listing.
- For Pinia requests, use the correct package name 'pinia'. Install it with the package manager, create or update a store file with fileManager, and register createPinia() in the Vue entry file. Do not return manual shell heredocs or PowerShell write scripts as the workflow result.
- If the goal asks for image links, image URLs, remote images, external images, or CDN images, set imageGenerator toolInput.outputMode to 'url'. When creating HTML, use the returned imageUrl directly in img src, CSS background-image, hero slides, product cards, and category cards.
- For every requested HTML homepage, generate the complete document in fileManager toolInput.content from the exact user prompt. Do not use a fixed homepage template, fixed brand copy, fixed colors, fixed product names, or generic fallback content. Vary the layout, typography, content, color system, and components to match the requested subject and constraints.
- For every project setup request, derive the project name, framework, runtime, dependencies, files, commands, and source content from the exact user prompt. Do not add a fixed demo project, fixed file names, fixed starter copy, or generic fallback source. If the user did not request a file, do not invent one.
- When the user provides an explicit directory tree or file list, treat every listed directory and file as required acceptance criteria. Create every directory at the exact relative path and create every listed source/configuration/SQL file with complete content derived from the prompt. Use fileManager tasks with one exact path per file (or a createFiles batch containing exact paths); never return only the project directory, a services folder, or README.md for a tree-based project request.
- For a local Desktop project setup, make the workflow resumable: use fileManager toolInput.ifExists='skip' for createDesktopFile/createDesktopFiles (and equivalent create-file actions) unless the user explicitly asks to overwrite, replace, update, modify, or rewrite existing files. Existing project folders are reused; existing files are preserved and reported as skipped rather than failing the whole workflow.
- When the user explicitly asks to update, modify, edit, rewrite, refactor, replace, or overwrite an existing project, use update semantics for generated non-empty files: use fileManager action 'update', createDesktopFile mode 'update', or per-file mode 'update' in createFiles/createDesktopFiles. If generated content is empty, use ifExists='skip' so an existing file is never cleared accidentally. Do not use create mode for an explicitly authorized existing-project update.
- Never infer a feature-specific starter such as login, health, users, or authentication from an architecture keyword alone. Generate only the files and behavior required by the current user prompt; preserve the model-generated source content during normalization.
- For project setup requests, derive verification from the exact user prompt and the generated project. If the prompt asks for validation, testing, compilation, or a package-manager check, add the appropriate final command task using the requested runtime and command. Do not invent a framework, package manager, test command, file, dependency, or verification step that the user did not request or that the generated project does not support.
- For generic project preparation, cleanup, tidying, or organization requests, inspect the existing project first. Do not infer npm run build, tests, linting, dependency installation, file deletion, or file overwrites unless the user explicitly requests that operation. If the cleanup target is ambiguous, report the inspection result and wait for a specific change request.
- If a Vue/Vite prompt explicitly asks for a build, ensure package.json contains a scripts.build value of "vite build" before running "npm run build". Add that repair as a dependent npm task; do not report a missing build script as an unrecoverable error.
- Return strict JSON. Escape every literal backslash inside a JSON string, especially backslashes in regexes, Windows paths, JavaScript, CSS, and Python source. Never emit invalid JSON escapes such as \\s, \\d, \\., or \\Users; represent them as \\\\s, \\\\d, \\\\., and \\\\Users in the JSON response.
- Never invent an ESLint, Prettier, or lint command for a project setup. Add a lint task only when the exact user prompt asks for linting/ESLint/Prettier and the generated project includes the corresponding configuration/dependency.
- Never replace model-generated source content with a generic fallback. If a requested source file has no generated content, preserve it as an empty file and keep the requested filename; do not fabricate unrelated code.
- A request containing a filename ending in .html or .htm is always a source-code request. Create that exact filename with fileManager and complete HTML content. Never rename it to .png, never use imageGenerator for it, and implement requested dark/light mode behavior with HTML, CSS, and JavaScript.
- Use imageGenerator only when the user explicitly requests an image, photo, logo, banner, illustration, artwork, or image URL. Words such as homepage, ecommerce, product, dark mode, or light mode alone do not request an image.
- If the HTML request asks for remote or generated images, use placeholders such as {{imageUrl:homepage_product_image_1}} in toolInput.content. Use one sequential placeholder per distinct image and create matching imageGenerator tasks; never hardcode stock image URLs.
- For a Vue page with multiple components, use fileManager action 'createFiles' with a files array of {path, content} objects; do not invent createFile, writeFile, or writefile actions.
- When modifying or adding files/folders to an existing local project (e.g. 'Api-Productions/Sample-RESTful-API-'): Always inspect and follow the project's existing directory structure. If the project places its code folders (such as controllers/, routes/, models/) directly at the project root, place new folders (like validation/) directly at the project root matching the existing pattern. NEVER prepend or create an unneeded 'src/' folder, NEVER create subfolders named 'desktops', and NEVER duplicate existing files into 'src/'.
- When asked to add validation to routes, do not merely create a validator file; also update the existing router/controller files to import and apply the validation middleware to the routes so the validation is actually active.
- PROJECT STRUCTURE CLEANUP RULE: When the user requests to clean, organize, or modify a project structure (e.g. 'modify structure project to clean', 'clean up project structure', 'remove unused folders', 'clean redundant folder', 'remove already but it still have'):
  - Inspect the project's layout and remove redundant or unneeded directories in-place using fileManager with action 'deleteDesktopPath' (e.g., {"action":"deleteDesktopPath","path":"<project>/src","kind":"directory"}).
  - NEVER export to Downloads or divert the project when the user asks to clean an existing local project.
${desktopInstruction}
${largeTreeInstruction}
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
        let explicitTreeCompletionAttempts = 0;
        let explicitTreeCompletionError = null;

        while (attempts < maxAttempts) {
            attempts++;

            try {
                console.log(`📡 [Planner] Invoking LLM Planner (Attempt ${attempts}/${maxAttempts})...`);

                const rawResult = await generateStructureClient({
                    systemPrompt,
                    userPrompt: currentPrompt,
                    images,
                    runId,
                    io,
                });

                const parsed = validatePlan(rawResult.data, {
                    goalPrompt: planningGoalPrompt,
                    localDestination: effectiveDestination,
                });

                if (!parsed.success) {
                    lastPlannerError = new Error(parsed.error.message);
                    console.warn('⚠️ [Planner] Plan validation failed:', parsed.error.message);

                    // Large tree-based project requests can exceed one model
                    // response. Complete the missing files in smaller dynamic
                    // batches before spending another full-plan retry.
                    if (explicitTreeCompletionAttempts < 1
                        && /The plan is incomplete/i.test(parsed.error.message)
                        && isNodeProjectSetupRequest(planningGoalPrompt)) {
                        explicitTreeCompletionAttempts += 1;
                        try {
                            const completedPlan = await completeExplicitProjectTreePlan({
                                basePlan: rawResult.data,
                                goalPrompt: planningGoalPrompt,
                                runId,
                                io,
                            });
                            const completedValidation = validatePlan(completedPlan, {
                                goalPrompt: planningGoalPrompt,
                                localDestination: effectiveDestination,
                            });

                            if (completedValidation.success) {
                                validatedPlan = completedValidation.data;
                                if (planCache.size < MAX_CACHE_SIZE) {
                                    planCache.set(cacheKey, validatedPlan);
                                }
                                break;
                            }

                            lastPlannerError = new Error(completedValidation.error.message);
                            explicitTreeCompletionError = lastPlannerError;
                            console.warn('⚠️ [Planner] File completion validation failed:', completedValidation.error.message);
                        } catch (completionError) {
                            lastPlannerError = completionError;
                            explicitTreeCompletionError = completionError;
                            console.warn('⚠️ [Planner] Explicit file completion failed:', completionError.message);
                        }

                        // The bounded completion pass already made the only
                        // useful recovery attempt for a large explicit tree.
                        // Retrying the full planner here would repeat the same
                        // expensive response and can outlive the API request.
                        if (!validatedPlan) {
                            break;
                        }
                    }

                    const recoveryMessage = explicitTreeCompletionError?.message || parsed.error.message;
                    currentPrompt = `Previous output had validation errors: ${recoveryMessage}. Generate a corrected plan for this goal:\n${planningGoalPrompt}`;
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
                const errorCode = Number(error.code);
                const shouldStopPlannerRetries = [
                    'LLM_UNAVAILABLE',
                    'LLM_ERROR',
                    'LLM_TIMEOUT',
                ].includes(error.code)
                    || [400, 401, 403, 404, 503].includes(errorCode)
                    || [400, 401, 403, 404, 503].includes(Number(error.status));

                if (shouldStopPlannerRetries) {
                    break;
                }
                currentPrompt = `An error occurred: ${error.message}. Generate valid DAG JSON for this goal:\n${planningGoalPrompt}`;
            }
        }

        if (!validatedPlan) {
            let fallbackTasks = normalizeServerReviewAndFixTasks([], goalPrompt, effectiveDestination);
            if (!fallbackTasks || !fallbackTasks.length) {
                fallbackTasks = normalizeGitPushWorkflowTasks([], goalPrompt, effectiveDestination);
            }
            if (fallbackTasks && fallbackTasks.length > 0) {
                console.log(`🛡️ [Planner Resilience] Using deterministic plan for ${goalPrompt}`);
                validatedPlan = {
                    workflowTitle: `Deploy to GitHub for ${effectiveDestination || 'Project'}`,
                    summary: `Autonomously stage, commit, set branch to main, and push to GitHub.`,
                    tasks: fallbackTasks,
                };
            }
        }

        if (!validatedPlan) {
            await updateExecutionRunStatus(runId, 'FAILED');

            const errorMessage = lastPlannerError?.message || 'Failed to generate a valid acyclic DAG plan after maximum attempts.';
            const error = new Error(errorMessage);
            error.code = lastPlannerError?.code === 'LLM_INVALID_JSON'
                ? 'LLM_INVALID_JSON'
                : [408, 500, 502, 503, 504].includes(Number(lastPlannerError?.code))
                    || ['LLM_UNAVAILABLE', 'LLM_ERROR', 'LLM_TIMEOUT'].includes(lastPlannerError?.code)
                    ? 'LLM_UNAVAILABLE'
                    : 'PLANNER_ERROR';
            error.status = Number(lastPlannerError?.status) || undefined;
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
    completeExplicitProjectTreePlan,
    validateAcyclicGraph,
    normalizePlan,
    validatePlan,
    planWorkflowRun,
};
