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
const DEFAULT_PINIA_STORE = `import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useCounterStore = defineStore('counter', () => {
  const count = ref(0)

  function increment() {
    count.value += 1
  }

  return {count, increment}
})
`;
const DEFAULT_PINIA_MAIN = `import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './style.css'

const app = createApp(App)
app.use(createPinia())
app.mount('#app')
`;

const escapeHtml = (value) => String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

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

const extractRequestedMessage = (goalPrompt) => {
    const text = String(goalPrompt || '').replace(/\s+/g, ' ').trim();
    const quotedMatch = text.match(
        /\b(?:display|displya|displaying|print|printing|show|showing|say|says|output|outputs|write|writes)\s+(?:the\s+)?(?:message|text|content)?\s*["']([^"']+)["']/i,
    );
    const unquotedMatch = text.match(
        /\b(?:display|displya|displaying|print|printing|show|showing|say|says|output|outputs|write|writes)\s+(?:the\s+)?(?:message|text|content)?\s+(.+?)(?=\s+(?:on|in|inside|under|within|from|to|as|named|called|folder|file)\b|[?.!,]|$)/i,
    );
    const message = (quotedMatch?.[1] || unquotedMatch?.[1] || '').trim();

    return message
        .replace(/^(?:the|a|an)\s+/i, '')
        .replace(/\s+/g, ' ')
        .slice(0, 160)
        .trim();
};

const createRequestedHomepageContent = (goalPrompt) => {
    const rawTopic = extractHomepageTopic(goalPrompt) || 'your idea';
    const topic = rawTopic[0].toUpperCase() + rawTopic.slice(1);
    const safeTopic = escapeHtml(topic);
    const lowerTopic = rawTopic.toLowerCase();
    const isCoffee = /\bcoffee|cafe|café|espresso|roast|latte|brew\b/i.test(lowerTopic);
    const eyebrow = isCoffee ? 'Small-batch coffee, thoughtfully made' : `${safeTopic} made with intention`;
    const headline = isCoffee ? 'Good coffee.<br><em>Great mornings.</em>' : `${safeTopic}.<br><em>Made to matter.</em>`;
    const description = isCoffee
        ? 'Explore rich roasts, smooth espresso, and the quiet ritual of a cup made just for you.'
        : `Discover a considered homepage for ${safeTopic}, built around clarity, character, and a memorable first impression.`;
    const featureOne = isCoffee ? 'Roasted with care' : 'Thoughtful details';
    const featureTwo = isCoffee ? 'Fresh every morning' : 'A clear point of view';
    const featureThree = isCoffee ? 'Made for your ritual' : 'Built for connection';

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTopic} | Made with intention</title>
  <style>
    :root { --ink:#211814; --muted:#776b63; --roast:#8b5e3c; --caramel:#c8955b; --cream:#f7f1e9; --paper:#fffdf9; }
    * { box-sizing:border-box; }
    body { margin:0; color:var(--ink); background:var(--cream); font-family:Inter,system-ui,sans-serif; }
    .wrap { max-width:1120px; margin:auto; padding:0 28px; }
    header { display:flex; justify-content:space-between; align-items:center; padding:28px 0; border-bottom:1px solid #dfd2c5; }
    .brand { font-weight:800; letter-spacing:.16em; text-transform:uppercase; }
    nav { display:flex; gap:24px; color:var(--muted); font-size:14px; }
    nav a { color:inherit; text-decoration:none; }
    .eyebrow { color:var(--roast); font-size:12px; font-weight:700; letter-spacing:.18em; text-transform:uppercase; }
    .hero { display:grid; grid-template-columns:1.05fr .95fr; gap:64px; align-items:center; min-height:620px; }
    h1 { max-width:700px; margin:20px 0; font:400 clamp(54px,8vw,92px)/.98 Georgia,serif; letter-spacing:-.06em; }
    h1 em { color:var(--caramel); font-style:normal; }
    .lead { max-width:520px; color:var(--muted); font-size:18px; line-height:1.75; }
    .button { display:inline-block; margin-top:26px; padding:15px 24px; color:var(--paper); background:var(--ink); border-radius:999px; font-size:13px; font-weight:700; text-decoration:none; }
    .visual { min-height:470px; border-radius:240px 240px 18px 18px; background:radial-gradient(circle at 35% 25%,#c8955b 0 8%,transparent 9%), linear-gradient(145deg,#2b1b16,#9b6a3d); box-shadow:0 30px 80px #2118142b; display:grid; place-items:center; color:var(--paper); }
    .visual strong { font:400 82px Georgia,serif; letter-spacing:-.08em; }
    .section { padding:76px 0; border-top:1px solid #dfd2c5; }
    h2 { font:400 46px Georgia,serif; margin:12px 0 34px; }
    .grid { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; }
    article { padding:26px; background:var(--paper); border:1px solid #e8ded4; }
    article h3 { margin:48px 0 10px; font:400 27px Georgia,serif; }
    article p, footer { color:var(--muted); line-height:1.7; }
    footer { display:flex; justify-content:space-between; gap:20px; padding:30px 0; font-size:13px; }
    @media (max-width:760px) { nav { display:none; } .hero { grid-template-columns:1fr; padding:58px 0; } .grid { grid-template-columns:1fr; } footer { display:block; } footer > * { margin:12px 0; } }
  </style>
</head>
<body>
  <div class="wrap">
    <header><div class="brand">${safeTopic}</div><nav><a href="#story">Story</a><a href="#details">Details</a><a href="#contact">Contact</a></nav><span class="eyebrow">Made with care</span></header>
    <main>
      <section class="hero"><div><div class="eyebrow">${eyebrow}</div><h1>${headline}</h1><p class="lead">${description}</p><a class="button" href="#details">Explore ${safeTopic}</a></div><div class="visual"><strong>${escapeHtml(topic[0] || '•')}</strong></div></section>
      <section class="section" id="details"><div class="eyebrow">The details matter</div><h2>A little more intention in every moment.</h2><div class="grid"><article><div class="eyebrow">01 / 03</div><h3>${featureOne}</h3><p>Careful choices create an experience worth returning to.</p></article><article><div class="eyebrow">02 / 03</div><h3>${featureTwo}</h3><p>Simple, warm, and clear from the very first visit.</p></article><article><div class="eyebrow">03 / 03</div><h3>${featureThree}</h3><p>Designed to bring people closer to what they enjoy.</p></article></div></section>
      <section class="section" id="story"><div class="eyebrow">A story worth sharing</div><h2>${safeTopic} with a point of view.</h2><p class="lead">This homepage is shaped around ${safeTopic.toLowerCase()} and ready for your own story, images, products, and contact details.</p></section>
    </main>
    <footer id="contact"><strong>${safeTopic}</strong><span>Thoughtfully made for curious people.</span><span>© 2026</span></footer>
  </div>
</body>
</html>`;
};
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
            instruction: `Copy the completed workflow output to the local Desktop folder ${exportPath}.`,
            dependencies: tasks.map((task) => task.nodeKey),
            assignedTool: 'fileManager',
            toolInput: {
                action: 'exportWorkspaceToDesktop',
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
                    content: createRequestedHomepageContent(goalPrompt),
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
                content: createRequestedHomepageContent(goalPrompt),
            },
        },
    ];
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

const fallbackDesktopFileContent = (fileName, goalPrompt) => {
    const extension = path.extname(fileName).toLowerCase();
    const baseName = path.basename(fileName, extension);
    const topic = extractHomepageTopic(goalPrompt) || baseName;
    const requestedMessage = extractRequestedMessage(goalPrompt);
    const className = baseName
        .replace(/[^A-Za-z0-9]+/g, ' ')
        .split(' ')
        .filter(Boolean)
        .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
        .join('') || 'Main';

    if (extension === '.html' || extension === '.htm') {
        return createRequestedHomepageContent(goalPrompt);
    }

    if (extension === '.java') {
        const message = requestedMessage || (/hello\s+world/i.test(goalPrompt) ? 'Hello World' : `Generated for ${topic}`);
        return `public class ${className} {\n    public static void main(String[] args) {\n        System.out.println(${JSON.stringify(message)});\n    }\n}\n`;
    }

    if (extension === '.json') {
        return `${JSON.stringify({title: topic, message: requestedMessage || `Generated for ${topic}`}, null, 2)}\n`;
    }

    if (extension === '.md' || extension === '.txt') {
        return `# ${topic}\n\n${requestedMessage || `Content created for ${topic}.`}\n`;
    }

    if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
        const message = requestedMessage || (/hello\s+world/i.test(goalPrompt) ? 'Hello World' : `Hello from ${topic}`);
        return `// Generated for ${topic}\nconsole.log(${JSON.stringify(message)});\n`;
    }

    return `/* Generated for ${topic} */\n`;
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
            const requestedMessage = extractRequestedMessage(goalPrompt);
            const existingContentMatchesGoal = !requestedMessage
                || existingContent.toLowerCase().includes(requestedMessage.toLowerCase());
            const hasUnrelatedGeneratedContent = /(?:generated by kairo|kairo is ready|autonomous intelligence)/i.test(existingContent);
            const fallbackContent = fallbackDesktopFileContent(fileName, goalPrompt);
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
                    content: existingContent && existingContentMatchesGoal && !hasUnrelatedGeneratedContent
                        ? existingContent
                        : fallbackContent,
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
                content: fallbackDesktopFileContent(fileName, goalPrompt),
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
            title: 'Create Pinia counter store',
            instruction: `Create a starter Pinia store at ${storePath}.`,
            dependencies: [...new Set([...(storeTask.dependencies || []), installTask.nodeKey])]
                .filter((dependency) => dependency !== storeTask.nodeKey),
            assignedTool: 'fileManager',
            toolInput: {
                action: 'createDesktopFile',
                mode: 'update',
                path: storePath,
                content: DEFAULT_PINIA_STORE,
            },
        };
        nextTasks[storeIndex] = storeTask;
    } else {
        storeTask = {
            nodeKey: getUniqueNodeKey(nextTasks, 'create_pinia_store'),
            title: 'Create Pinia counter store',
            instruction: `Create a starter Pinia store at ${storePath}.`,
            dependencies: [installTask.nodeKey],
            assignedTool: 'fileManager',
            toolInput: {
                action: 'createDesktopFile',
                mode: 'update',
                path: storePath,
                content: DEFAULT_PINIA_STORE,
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
                content: DEFAULT_PINIA_MAIN,
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
                content: DEFAULT_PINIA_MAIN,
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

        // A Desktop directory task establishes the destination for dependent file writes.
        // Without this pass, the directory goes to ~/Desktop while its files stay in workspaces/<runId>.
        plan.tasks = normalizeDesktopFileTasks(plan.tasks, goalPrompt);
        // A direct Desktop request must always produce both the directory and index.html task,
        // even when the LLM returns an incomplete plan containing only the directory step.
        plan.tasks = ensureDesktopIndexTask(plan.tasks, goalPrompt);
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
        // Local development users should be able to open the generated project in Finder.
        plan.tasks = appendDesktopExportTask(plan.tasks, goalPrompt);

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
            ? `- Local Desktop access is enabled for development. For a request to create a folder directly on the Mac Desktop, use fileManager with {"action":"createDesktopDirectory","path":"requested-folder"}. For a project setup inside that folder, first create the folder with fileManager, then use executeCommand with a relative cwd and desktop:true for the approved package-manager command. To list local assets, use fileManager with {"action":"listDesktopDirectory","path":"requested-folder","imagesOnly":true}; to export a completed project for Finder, use fileManager with {"action":"exportWorkspaceToDesktop","path":"requested-folder"}; never use executeCommand to create a Desktop directory or to access arbitrary absolute Desktop paths.`
            : '- Host Desktop output is disabled. Use fileManager action createDirectory with a relative path inside the workflow workspace; never target a host Desktop.';
        const systemPrompt = `
You are KAIRO, an autonomous AI workflow planner.
Decompose the user goal into a Directed Acyclic Graph (DAG) of executable subtasks.
Available Tools:
1. 'executeCommand' - Run allowlisted workspace commands such as cat, head, tail, grep, ls, pwd, find, wc, npm, npx, node, and git. Never use executeCommand or mkdir for directory creation; use fileManager instead.
2. 'fileManager' - Create, edit, read, list, delete files, create workspace directories, access a local Desktop directory, or export a completed workspace to the local Desktop when explicitly enabled. Use {"action":"createDirectory","path":"relative/directory"} for workspace directories, {"action":"listDesktopDirectory","path":"requested-folder","imagesOnly":true} to list local Desktop image assets, and {"action":"exportWorkspaceToDesktop","path":"requested-folder"} to export the completed project.
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
- Never assign executeCommand to a directory or folder creation task. For a local Desktop project setup, it is valid to run the project scaffolding and dependency-install commands with a relative Desktop cwd after the directory task succeeds.
- For requests to generate a visual image, logo, icon, banner, illustration, or artwork, assign imageGenerator. Do not answer with a textual design description or use fileManager to create an SVG unless the user explicitly requests source code.
- Use imageGenerator only for visual image, logo, icon, banner, illustration, or artwork generation. Never use it for HTML, JSON, CSS, JavaScript, metadata, project structure, file creation, or asset listing.
- For Pinia requests, use the correct package name 'pinia'. Install it with the package manager, create or update a store file with fileManager, and register createPinia() in the Vue entry file. Do not return manual shell heredocs or PowerShell write scripts as the workflow result.
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
