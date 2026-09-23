const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');

const DEFAULT_WORKSPACE_ROOT = path.resolve(
    process.env.WORKSPACE_ROOT || path.join(process.cwd(), 'workspaces'),
);
const MAX_FILE_SIZE = 5 * 1024 * 1024;

const parseToolInput = (value) => {
    if (typeof value !== 'string') {
        return value || {};
    }

    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : {};
    } catch (error) {
        throw new Error('Task tool_input must contain valid JSON');
    }
};

const getWorkspacePath = async (runId, workspaceRoot = DEFAULT_WORKSPACE_ROOT) => {
    if (!runId || typeof runId !== 'string') {
        throw new Error('Task run_id is required');
    }

    const rootPath = path.resolve(workspaceRoot);
    const workspacePath = path.resolve(rootPath, runId);
    const rootPrefix = `${rootPath}${path.sep}`;

    if (!workspacePath.startsWith(rootPrefix)) {
        throw new Error('run_id must resolve inside the workspace root');
    }

    await fs.mkdir(workspacePath, {recursive: true});

    return workspacePath;
};

const resolveWorkspaceFile = (workspacePath, requestedPath) => {
    if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
        throw new Error('A relative file path is required');
    }

    if (path.isAbsolute(requestedPath)) {
        throw new Error('Absolute file paths are not allowed');
    }

    const resolvedPath = path.resolve(workspacePath, requestedPath);
    const workspacePrefix = `${path.resolve(workspacePath)}${path.sep}`;

    if (!resolvedPath.startsWith(workspacePrefix)) {
        throw new Error('File path must remain inside the task workspace');
    }

    return resolvedPath;
};

const validateContent = (content) => {
    if (typeof content !== 'string') {
        throw new Error('File content must be a string');
    }

    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_SIZE) {
        throw new Error('File content exceeds the 5 MB limit');
    }
};

const fileManager = async (input, workspacePath) => {
    const action = input.action || 'read';
    const filePath = resolveWorkspaceFile(workspacePath, input.path);

    if (action === 'read') {
        const content = await fs.readFile(filePath, 'utf8');

        return {
            action,
            path: input.path,
            content,
        };
    }

    if (action === 'list') {
        const entries = await fs.readdir(filePath, {withFileTypes: true});

        return {
            action,
            path: input.path,
            entries: entries.map((entry) => ({
                name: entry.name,
                type: entry.isDirectory() ? 'directory' : 'file',
            })),
        };
    }

    validateContent(input.content);
    await fs.mkdir(path.dirname(filePath), {recursive: true});

    if (action === 'create') {
        await fs.writeFile(filePath, input.content, {
            encoding: 'utf8',
            flag: input.overwrite === true ? 'w' : 'wx',
        });
    } else if (action === 'write' || action === 'update') {
        await fs.writeFile(filePath, input.content, 'utf8');
    } else if (action === 'append') {
        await fs.appendFile(filePath, input.content, 'utf8');
    } else {
        throw new Error(`Unsupported fileManager action: ${action}`);
    }

    return {
        action,
        path: input.path,
        bytesWritten: Buffer.byteLength(input.content, 'utf8'),
    };
};

const decodeHtml = (value) => {
    return String(value || '')
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&#x([0-9a-f]+);/gi, (match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
        .replace(/&#(\d+);/g, (match, code) => String.fromCodePoint(Number.parseInt(code, 10)))
        .replace(/\s+/g, ' ')
        .trim();
};

const normalizeSearchUrl = (href) => {
    try {
        const value = href.startsWith('//') ? `https:${href}` : href;
        const url = new URL(value);
        const redirectedUrl = url.searchParams.get('uddg');

        return redirectedUrl ? decodeURIComponent(redirectedUrl) : url.toString();
    } catch (error) {
        return null;
    }
};

const webSearch = async (input) => {
    const query = typeof input.query === 'string' ? input.query.trim() : '';

    if (!query) {
        throw new Error('A search query is required');
    }

    if (query.length > 500) {
        throw new Error('Search query cannot exceed 500 characters');
    }

    const response = await axios.get('https://html.duckduckgo.com/html/', {
        params: {q: query},
        headers: {
            'User-Agent': 'OmniAgent/1.0',
        },
        timeout: 10000,
        maxContentLength: 2 * 1024 * 1024,
    });

    const html = String(response.data || '');
    const resultPattern = /<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    const results = [];
    let match;

    while ((match = resultPattern.exec(html)) && results.length < 5) {
        const url = normalizeSearchUrl(match[1]);

        if (!url) {
            continue;
        }

        results.push({
            title: decodeHtml(match[2]),
            url,
        });
    }

    return {
        query,
        results,
    };
};

const createToolRegistry = (tools = {}) => ({
    fileManager,
    webSearch,
    ...tools,
});

const executeTaskNode = async (task, options = {}) => {
    const runId = task.run_id || task.runId;
    const assignedTool = task.assigned_tool || task.assignedTool;
    const toolRegistry = createToolRegistry(options.tools);

    if (!assignedTool) {
        const error = new Error('Task assigned_tool is required');
        error.code = 'INVALID_TASK_TOOL';
        throw error;
    }

    const tool = toolRegistry[assignedTool];

    if (typeof tool !== 'function') {
        const error = new Error(`Tool is not configured: ${assignedTool}`);
        error.code = 'TOOL_NOT_CONFIGURED';
        throw error;
    }

    const workspacePath = await getWorkspacePath(runId, options.workspaceRoot);
    const input = parseToolInput(task.tool_input || task.toolInput);

    console.log(
        `🛠️ [Executor 4.0] Executing Task [${task.node_key || task.nodeKey}] ` +
        `using Tool [${assignedTool}]...`,
    );

    const result = await tool(input, workspacePath, task);

    if (result && result.exitCode !== undefined && result.exitCode !== 0) {
        const error = new Error(
            result.stderr || `Command exited with code ${result.exitCode}`,
        );
        error.code = 'TASK_TOOL_FAILED';
        throw error;
    }

    return result ?? {
        success: true,
    };
};

module.exports = {
    createToolRegistry,
    executeTaskNode,
    fileManager,
    webSearch,
};
