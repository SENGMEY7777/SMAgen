const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');
const {execFile} = require('child_process');
const {promisify} = require('util');
const databasePool = require('../configs/db');

const DEFAULT_WORKSPACE_ROOT = path.resolve(
    process.env.WORKSPACE_ROOT || path.join(process.cwd(), 'workspaces'),
);
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_COMMAND_OUTPUT = 1024 * 1024;
const COMMAND_TIMEOUT_MS = Math.max(
    1000,
    Number.parseInt(process.env.COMMAND_TIMEOUT_MS || '30000', 10) || 30000,
);
const HTTP_REQUEST_TIMEOUT_MS = Math.max(
    1000,
    Number.parseInt(process.env.HTTP_REQUEST_TIMEOUT_MS || '10000', 10) || 10000,
);
const execFileAsync = promisify(execFile);
const SAFE_COMMANDS = new Set(['cat', 'head', 'tail', 'grep', 'ls', 'pwd', 'find', 'wc']);
const SENSITIVE_HEADER_PATTERN = /authorization|cookie|set-cookie|token|secret|api[-_]?key|password/i;
const SAFE_WORKSPACE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

const isPathInside = (rootPath, targetPath) => {
    const normalizedRoot = path.resolve(rootPath);
    const normalizedTarget = path.resolve(targetPath);

    return normalizedTarget === normalizedRoot
        || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
};

const assertRealPathInsideWorkspace = async (workspacePath, requestedPath) => {
    const realWorkspacePath = await fs.realpath(workspacePath);
    let probePath = path.resolve(requestedPath);

    while (true) {
        try {
            const realProbePath = await fs.realpath(probePath);

            if (!isPathInside(realWorkspacePath, realProbePath)) {
                throw new Error('Path must remain inside the task workspace');
            }

            return;
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }

            const parentPath = path.dirname(probePath);

            if (parentPath === probePath) {
                throw new Error('Unable to validate workspace path');
            }

            probePath = parentPath;
        }
    }
};

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

    if (!SAFE_WORKSPACE_SEGMENT.test(runId)) {
        throw new Error('Task run_id must be a single safe workspace directory name');
    }

    const rootPath = path.resolve(workspaceRoot);
    const workspacePath = path.resolve(rootPath, runId);
    const rootPrefix = `${rootPath}${path.sep}`;

    if (!workspacePath.startsWith(rootPrefix)) {
        throw new Error('run_id must resolve inside the workspace root');
    }

    await fs.mkdir(workspacePath, {recursive: true});
    await assertRealPathInsideWorkspace(rootPath, workspacePath);

    return workspacePath;
};

const resolveWorkspaceFile = async (workspacePath, requestedPath, {allowWorkspaceRoot = false} = {}) => {
    if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
        throw new Error('A relative file path is required');
    }

    if (path.isAbsolute(requestedPath)) {
        throw new Error('Absolute file paths are not allowed');
    }

    const resolvedPath = path.resolve(workspacePath, requestedPath);
    const normalizedWorkspacePath = path.resolve(workspacePath);
    const workspacePrefix = `${normalizedWorkspacePath}${path.sep}`;

    if (resolvedPath !== normalizedWorkspacePath && !resolvedPath.startsWith(workspacePrefix)) {
        throw new Error('File path must remain inside the task workspace');
    }

    if (resolvedPath === normalizedWorkspacePath && !allowWorkspaceRoot) {
        throw new Error('The task workspace root is not a file');
    }

    await assertRealPathInsideWorkspace(workspacePath, resolvedPath);

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
    const filePath = await resolveWorkspaceFile(workspacePath, input.path, {
        allowWorkspaceRoot: action === 'list',
    });

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

    if (action === 'delete' || action === 'remove') {
        if (filePath === path.resolve(workspacePath)) {
            throw new Error('The task workspace itself cannot be deleted');
        }

        await fs.rm(filePath, {recursive: true, force: false});

        return {
            action: 'delete',
            path: input.path,
        };
    }

    if (!['create', 'write', 'update', 'append'].includes(action)) {
        throw new Error(`Unsupported fileManager action: ${action}`);
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

const htmlToMarkdown = (html) => {
    return String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, '\n\n$1\n\n')
        .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n\n$1\n\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&#x([0-9a-f]+);/gi, (match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
        .replace(/&#(\d+);/g, (match, code) => String.fromCodePoint(Number.parseInt(code, 10)))
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n\s*\n/g, '\n\n')
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

    let markdown = results
        .map((result, index) => `${index + 1}. [${result.title}](${result.url})`)
        .join('\n');

    if (input.scrape === true) {
        const scrapeLimit = Math.min(5, Math.max(1, Number(input.maxResults) || 3));
        const scrapedResults = await Promise.all(results.slice(0, scrapeLimit).map(async (result) => {
            try {
                const pageResponse = await axios.get(result.url, {
                    headers: {
                        'User-Agent': 'OmniAgent/1.0',
                    },
                    timeout: 10000,
                    maxContentLength: 2 * 1024 * 1024,
                });

                return {
                    ...result,
                    markdown: htmlToMarkdown(pageResponse.data).slice(0, 50000),
                };
            } catch (error) {
                return {
                    ...result,
                    scrapeError: error.message || 'Unable to scrape result page',
                };
            }
        }));

        results.splice(0, scrapedResults.length, ...scrapedResults);
        markdown = results
            .map((result, index) => {
                const heading = `${index + 1}. [${result.title}](${result.url})`;
                return result.markdown ? `${heading}\n\n${result.markdown}` : heading;
            })
            .join('\n\n');
    }

    return {
        query,
        results,
        markdown,
    };
};

const databaseConnector = async (input) => {
    const sql = typeof input.sql === 'string'
        ? input.sql.trim()
        : typeof input.query === 'string'
            ? input.query.trim()
            : '';

    if (!sql) {
        throw new Error('A parameterized SQL query is required');
    }

    const params = input.params ?? input.parameters ?? [];

    if (!Array.isArray(params)) {
        throw new Error('SQL parameters must be an array');
    }

    const [rows, fields] = await databasePool.execute(sql, params);

    return {
        sql,
        rows,
        fields: Array.isArray(fields)
            ? fields.map((field) => ({
                name: field.name,
                type: field.type,
            }))
            : [],
        rowCount: Array.isArray(rows) ? rows.length : Number(rows.affectedRows || 0),
    };
};

const maskHeaders = (headers = {}) => Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
        name,
        SENSITIVE_HEADER_PATTERN.test(name) ? '[MASKED]' : value,
    ]),
);

const httpRequester = async (input) => {
    const url = typeof input.url === 'string' ? input.url.trim() : '';

    if (!url) {
        throw new Error('An HTTP URL is required');
    }

    let parsedUrl;

    try {
        parsedUrl = new URL(url);
    } catch (error) {
        throw new Error('The HTTP URL is invalid');
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error('Only HTTP and HTTPS URLs are supported');
    }

    const method = String(input.method || 'GET').toUpperCase();
    const headers = input.headers && typeof input.headers === 'object' && !Array.isArray(input.headers)
        ? input.headers
        : {};
    const timeout = Math.min(
        30000,
        Math.max(1000, Number(input.timeout) || HTTP_REQUEST_TIMEOUT_MS),
    );
    const response = await axios.request({
        method,
        url,
        headers,
        params: input.params,
        data: input.data,
        timeout,
        maxContentLength: 5 * 1024 * 1024,
        maxBodyLength: 5 * 1024 * 1024,
    });

    return {
        method,
        url,
        requestHeaders: maskHeaders(headers),
        status: response.status,
        statusText: response.statusText,
        headers: maskHeaders(response.headers),
        data: response.data,
    };
};

const tokenizeCommand = (command) => {
    const tokens = command.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g) || [];

    return tokens.map((token) => {
        if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
            return token.slice(1, -1);
        }

        return token;
    });
};

const executeCommand = async (input, workspacePath) => {
    const command = typeof input.command === 'string' ? input.command.trim() : '';

    if (!command) {
        throw new Error('A command is required');
    }

    if (/[;&|`]|\$\(|>|<|\n/.test(command)) {
        throw new Error('Shell operators and command chaining are not allowed');
    }

    const [commandName, ...args] = tokenizeCommand(command);

    if (!SAFE_COMMANDS.has(commandName)) {
        throw new Error(`Command is not allowed: ${commandName}`);
    }

    for (const argument of args) {
        if (
            path.isAbsolute(argument)
            || argument.split(/[\\/]/).includes('..')
            || /[;&|`$()]/.test(argument)
        ) {
            throw new Error('Command arguments must remain inside the task workspace');
        }

        if (argument.startsWith('-')) {
            continue;
        }

        await assertRealPathInsideWorkspace(
            workspacePath,
            path.resolve(workspacePath, argument),
        );
    }

    try {
        const result = await execFileAsync(commandName, args, {
            cwd: workspacePath,
            timeout: COMMAND_TIMEOUT_MS,
            maxBuffer: MAX_COMMAND_OUTPUT,
            shell: false,
        });

        return {
            command,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: 0,
        };
    } catch (error) {
        return {
            command,
            stdout: error.stdout || '',
            stderr: error.stderr || error.message,
            exitCode: typeof error.code === 'number' ? error.code : 1,
            timedOut: error.code === 'ETIMEDOUT' || error.killed === true,
        };
    }
};

const createToolRegistry = (tools = {}) => ({
    fileManager,
    webSearch,
    executeCommand,
    databaseConnector,
    httpRequester,
    ...tools,
});

const getExitCode = (result) => {
    return Number.isInteger(result?.exitCode) ? result.exitCode : 0;
};

const createExecutionError = (result, latencyMs) => {
    const error = new Error(
        result?.stderr || `Task tool exited with code ${getExitCode(result)}`,
    );
    error.code = 'TASK_TOOL_FAILED';
    error.execution = {
        stdout: result?.stdout || '',
        stderr: result?.stderr || '',
        exitCode: getExitCode(result),
        latencyMs,
    };
    return error;
};

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

    const startedAt = Date.now();
    let result;

    try {
        result = await tool(input, workspacePath, task);
    } catch (error) {
        error.execution = error.execution || {
            stdout: error.stdout || '',
            stderr: error.stderr || error.message || 'Task execution failed',
            exitCode: Number.isInteger(error.code) ? error.code : 1,
            latencyMs: Date.now() - startedAt,
        };
        throw error;
    }

    const latencyMs = Date.now() - startedAt;
    const execution = {
        stdout: result?.stdout || '',
        stderr: result?.stderr || '',
        exitCode: getExitCode(result),
        latencyMs,
    };

    if (execution.exitCode !== 0) {
        throw createExecutionError(result, latencyMs);
    }

    return {
        outputData: result ?? {success: true},
        telemetry: execution,
    };
};

module.exports = {
    createToolRegistry,
    executeTaskNode,
    fileManager,
    webSearch,
    executeCommand,
    databaseConnector,
    httpRequester,
};
