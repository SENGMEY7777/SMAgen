const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const axios = require('axios');
const {execFile} = require('child_process');
const {promisify} = require('util');
const databasePool = require('../configs/db');
const {imageGenerator: rawImageGenerator} = require('../tools/imageGenerator');
const {maskSensitiveData} = require('./telemetry');

const DEFAULT_WORKSPACE_ROOT = path.resolve(
    process.env.WORKSPACE_ROOT
        || (String(process.env.NODE_ENV || 'development').trim().toLowerCase() === 'production'
            ? path.join(process.cwd(), 'workspaces')
            : path.join(os.tmpdir(), 'kairo-workspaces')),
);
const LOCAL_DESKTOP_OUTPUT_ENABLED = String(process.env.NODE_ENV || 'development').trim().toLowerCase() !== 'production'
    && String(process.env.LOCAL_DESKTOP_OUTPUT || '').trim().toLowerCase() === 'true';
const SERVER_FILE_ACCESS = String(process.env.SERVER_FILE_ACCESS || 'read-write').trim().toLowerCase();
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_COMMAND_OUTPUT = 1024 * 1024;
const MAX_COMMAND_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = Math.max(
    1000,
    Math.min(
        MAX_COMMAND_TIMEOUT_MS,
    Number.parseInt(process.env.COMMAND_TIMEOUT_MS || String(MAX_COMMAND_TIMEOUT_MS), 10)
            || MAX_COMMAND_TIMEOUT_MS,
    ),
);
const SSH_CONNECT_TIMEOUT_SECONDS = Math.max(
    3,
    Math.min(
        30,
        Number.parseInt(process.env.SSH_CONNECT_TIMEOUT_SECONDS || '10', 10) || 10,
    ),
);
const HTTP_REQUEST_TIMEOUT_MS = Math.max(
    1000,
    Number.parseInt(process.env.HTTP_REQUEST_TIMEOUT_MS || '10000', 10) || 10000,
);
const execFileAsync = promisify(execFile);
const SAFE_COMMANDS = new Set([
    'cat', 'head', 'tail', 'grep', 'ls', 'pwd', 'find', 'wc', 'mkdir',
    'node', 'npm', 'npx', 'git', 'pnpm', 'yarn', 'bun', 'python', 'python3',
    'pip', 'pip3', 'pytest', 'php', 'composer', 'mvn', 'go',
]);
const VIRTUAL_ENV_COMMAND_PATTERN = /^(?:\.\/)?\.?(?:venv)\/(?:bin\/(?:python|python3|pip|pip3)|Scripts\/(?:python|python3|pip|pip3)(?:\.exe)?)$/i;
const COMMAND_BLACKLIST_PATTERNS = [
    /\bsudo(?:\s|$)/i,
    /\bmkfs(?:\.[a-z0-9_-]+)?(?:\s|$)/i,
    /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?/i,
    /\b(?:shutdown|reboot)(?:\s|$)/i,
    /\b(?:nc|ncat|netcat)\b[^\n]*\s-e(?:\s|$)/i,
    /\b(?:bash|sh|zsh)\s+-i(?:\s|$)/i,
    /\bfind\b[^\n]*(?:-exec(?:dir)?|-delete|-ok(?:dir)?)/i,
];
const SSH_COMMAND_BLACKLIST_PATTERNS = [
    /\b(?:sudo|su|ssh|scp|sftp)\b/i,
    /\b(?:rm|rmdir)\b/i,
    /\b(?:shutdown|reboot|halt|poweroff|mkfs)\b/i,
    /\b(?:curl|wget)\b[^\n]*\|\s*(?:sh|bash|zsh)\b/i,
    /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?/i,
];
const SSH_TARGET_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SSH_USER_PATTERN = /^[A-Za-z_][A-Za-z0-9._-]{0,63}$/;
const SENSITIVE_HEADER_PATTERN = /authorization|cookie|set-cookie|token|secret|api[-_]?key|password/i;
const SAFE_WORKSPACE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;
const WORKSPACE_WRITE_ACTIONS = new Set([
    'create',
    'write',
    'update',
    'append',
    'createFiles',
    'createDirectory',
    'delete',
    'remove',
    'createDesktopDirectory',
    'createDesktopFile',
    'createDesktopFiles',
    'deleteDesktopPath',
    'renameDesktopPath',
    'exportWorkspaceToDesktop',
    'exportWorkspaceToDownloads',
]);

const assertServerFileWriteAccess = (action) => {
    if (SERVER_FILE_ACCESS === 'read-only' && WORKSPACE_WRITE_ACTIONS.has(action)) {
        const error = new Error(
            'Server file access is read-only. Set SERVER_FILE_ACCESS=read-write to allow workflow file changes.',
        );
        error.code = 'SERVER_FILE_ACCESS_READ_ONLY';
        error.status = 403;
        throw error;
    }
};

const isSkipExistingRequest = (input, mode = '') => {
    const requestedPolicy = String(input?.ifExists || '').trim().toLowerCase();
    const requestedMode = String(mode || '').trim().toLowerCase();
    return requestedPolicy === 'skip'
        || requestedPolicy === 'ensure'
        || requestedMode === 'skip'
        || requestedMode === 'ensure';
};

const readExistingPathStats = async (targetPath) => {
    try {
        return await fs.lstat(targetPath);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }

        throw error;
    }
};

const createFileTypeMismatchError = (requestedPath) => {
    const error = new Error(`The requested path is not a file: ${requestedPath}`);
    error.code = 'LOCAL_FILE_PATH_TYPE_MISMATCH';
    error.status = 409;
    return error;
};

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

const resolveLocalDesktopPath = async (requestedPath) => {
    if (!LOCAL_DESKTOP_OUTPUT_ENABLED) {
        throw new Error(
            'Direct Desktop output is disabled. Set LOCAL_DESKTOP_OUTPUT=true only for local development.',
        );
    }

    if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
        throw new Error('A relative Desktop path is required');
    }

    if (path.isAbsolute(requestedPath) || requestedPath.split(/[\\/]/).includes('..')) {
        throw new Error('Desktop paths must be relative and cannot contain ..');
    }

    const desktopRelativePath = requestedPath.replace(/^desktop[\\/]+/i, '');

    if (!desktopRelativePath.trim()) {
        throw new Error('A Desktop folder name is required');
    }

    const desktopRoot = path.join(os.homedir(), 'Desktop');
    const resolvedPath = path.resolve(desktopRoot, desktopRelativePath);

    if (!isPathInside(desktopRoot, resolvedPath)) {
        throw new Error('Desktop path must remain inside the local Desktop directory');
    }

    try {
        await fs.realpath(desktopRoot);
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw new Error(`Local Desktop directory does not exist: ${desktopRoot}`);
        }

        throw error;
    }

    await assertRealPathInsideWorkspace(desktopRoot, resolvedPath);

    return resolvedPath;
};

const getLocalDesktopRoot = async () => {
    if (!LOCAL_DESKTOP_OUTPUT_ENABLED) {
        throw new Error(
            'Direct Desktop output is disabled. Set LOCAL_DESKTOP_OUTPUT=true only for local development.',
        );
    }

    const desktopRoot = path.join(os.homedir(), 'Desktop');

    try {
        await fs.realpath(desktopRoot);
    } catch (error) {
        if (error.code === 'ENOENT') {
            const missingError = new Error(
                'Local Desktop directory does not exist: ' + desktopRoot,
            );
            missingError.code = 'LOCAL_DESKTOP_PATH_NOT_FOUND';
            missingError.status = 404;
            throw missingError;
        }

        throw error;
    }

    await assertRealPathInsideWorkspace(desktopRoot, desktopRoot);
    return desktopRoot;
};

const findLocalDesktopFiles = async (fileName, searchPath = '') => {
    const desktopRoot = await getLocalDesktopRoot();
    const searchRoot = searchPath
        ? await resolveLocalDesktopPath(searchPath)
        : desktopRoot;
    const matches = [];
    const ignoredDirectories = new Set(['.git', 'node_modules']);

    const visit = async (currentPath, depth = 0) => {
        if (depth > 12) return;
        if (matches.length > 50) return;

        let entries;
        try {
            entries = await fs.readdir(currentPath, {withFileTypes: true});
        } catch (error) {
            if (error.code === 'ENOENT') return;
            throw error;
        }

        for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;

            const entryPath = path.join(currentPath, entry.name);
            if (entry.isDirectory()) {
                if (!ignoredDirectories.has(entry.name)) {
                    await visit(entryPath, depth + 1);
                }
            } else if (entry.isFile() && entry.name === fileName) {
                matches.push(entryPath);
            }
        }
    };

    await visit(searchRoot);

    if (matches.length > 0) return matches;

    const normalizedName = String(fileName || '').toLowerCase();
    if (!normalizedName) return matches;

    const caseInsensitiveMatches = [];
    const visitCaseInsensitive = async (currentPath, depth = 0) => {
        if (depth > 12) return;
        if (caseInsensitiveMatches.length > 50) return;

        let entries;
        try {
            entries = await fs.readdir(currentPath, {withFileTypes: true});
        } catch (error) {
            if (error.code === 'ENOENT') return;
            throw error;
        }

        for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;

            const entryPath = path.join(currentPath, entry.name);
            if (entry.isDirectory()) {
                if (!ignoredDirectories.has(entry.name)) {
                    await visitCaseInsensitive(entryPath, depth + 1);
                }
            } else if (entry.isFile() && entry.name.toLowerCase() === normalizedName) {
                caseInsensitiveMatches.push(entryPath);
            }
        }
    };

    await visitCaseInsensitive(searchRoot);
    return caseInsensitiveMatches;
};

const resolveLocalDownloadsPath = async (requestedPath) => {
    if (!LOCAL_DESKTOP_OUTPUT_ENABLED) {
        throw new Error(
            'Direct Downloads output is disabled. Set LOCAL_DESKTOP_OUTPUT=true only for local development.',
        );
    }

    const downloadsRoot = path.join(os.homedir(), 'Downloads');
    await fs.mkdir(downloadsRoot, {recursive: true});

    if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
        throw new Error('A relative Downloads path is required');
    }

    if (path.isAbsolute(requestedPath) || requestedPath.split(/[\\/]/).includes('..')) {
        throw new Error('Downloads paths must be relative and cannot contain ..');
    }

    const downloadsRelativePath = requestedPath.replace(/^downloads[\\/]+/i, '');

    if (!downloadsRelativePath.trim()) {
        throw new Error('A Downloads folder name is required');
    }

    const resolvedPath = path.resolve(downloadsRoot, downloadsRelativePath);
    const realDownloadsRoot = await fs.realpath(downloadsRoot);

    if (!isPathInside(realDownloadsRoot, resolvedPath)) {
        throw new Error('Downloads path must remain inside the local Downloads directory');
    }

    await assertRealPathInsideWorkspace(downloadsRoot, resolvedPath);

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

const SOURCE_TEXT_EXTENSIONS = new Set([
    '.css', '.html', '.htm', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
    '.json', '.md', '.py', '.sql', '.txt', '.xml', '.yaml', '.yml',
]);

const normalizeGeneratedSourceContent = (content, requestedPath = '') => {
    if (typeof content !== 'string' || !SOURCE_TEXT_EXTENSIONS.has(path.extname(String(requestedPath)).toLowerCase())) {
        return content;
    }

    return content
        // Remove BOMs, control characters, and replacement/box glyphs that can
        // make otherwise valid generated source fail parsing or CSS tokenization.
        .replace(/[\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .replace(/[\s\u00A0]*[\u25A0\u25A1\u25AA\u25AB\uFFFD]+[\s\u00A0]*/g, ' ')
        .replace(/[ \t][\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000]+/g, ' ')
        .replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000]+[ \t]/g, ' ')
        .replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000]/g, ' ')
        .replace(/[\u25A0\u25A1\u25AA\u25AB\uFFFD]/g, '');
};

const findImageUrl = (value) => {
    if (!value) {
        return '';
    }

    if (typeof value === 'string') {
        return /^https?:\/\//i.test(value.trim()) ? value.trim() : '';
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            const imageUrl = findImageUrl(item);
            if (imageUrl) {
                return imageUrl;
            }
        }
        return '';
    }

    if (typeof value === 'object') {
        for (const key of ['imageUrl', 'remoteImageUrl', 'url', 'src']) {
            const imageUrl = findImageUrl(value[key]);
            if (imageUrl) {
                return imageUrl;
            }
        }
    }

    return '';
};

const resolveDynamicContent = (content, dependencyOutputs = {}) => {
    if (typeof content !== 'string' || !content.includes('{{imageUrl:')) {
        return content;
    }

    const unresolved = new Set();
    const resolvedContent = content.replace(/\{\{imageUrl:([A-Za-z0-9_-]+)\}\}/g, (placeholder, nodeKey) => {
        const imageUrl = findImageUrl(dependencyOutputs[nodeKey]);
        if (imageUrl) {
            return imageUrl;
        }

        unresolved.add(nodeKey);
        return placeholder;
    });

    if (unresolved.size) {
        throw new Error(`Dynamic image URL dependencies could not be resolved: ${[...unresolved].join(', ')}`);
    }

    return resolvedContent;
};

const fileManager = async (input, workspacePath, task = {}) => {
    const dependencyOutputs = task?.dependencyOutputs && typeof task.dependencyOutputs === 'object'
        ? task.dependencyOutputs
        : {};
    const resolveContent = (content) => resolveDynamicContent(content, dependencyOutputs);
    const requestedAction = String(input.action || 'read').trim().toLowerCase();
    const action = requestedAction === 'createdirectory' || requestedAction === 'create_directory'
        ? 'createDirectory'
        : requestedAction === 'createdesktopdirectory' || requestedAction === 'create_desktop_directory'
            ? 'createDesktopDirectory'
        : requestedAction === 'createdesktopfile' || requestedAction === 'create_desktop_file'
            ? 'createDesktopFile'
        : requestedAction === 'createdesktopfiles' || requestedAction === 'create_desktop_files'
            ? 'createDesktopFiles'
        : requestedAction === 'deletedesktoppath' || requestedAction === 'delete_desktop_path'
            ? 'deleteDesktopPath'
        : requestedAction === 'renamedesktoppath' || requestedAction === 'rename_desktop_path'
            ? 'renameDesktopPath'
        : requestedAction === 'createfile' || requestedAction === 'create_file'
            ? 'create'
        : requestedAction === 'writefile' || requestedAction === 'write_file'
            ? 'write'
        : requestedAction === 'updatefile' || requestedAction === 'update_file'
            ? 'update'
        : requestedAction === 'appendfile' || requestedAction === 'append_file'
            ? 'append'
        : requestedAction === 'createfiles' || requestedAction === 'create_files'
            ? 'createFiles'
        : requestedAction === 'writefiles' || requestedAction === 'write_files'
            ? 'createFiles'
        : requestedAction === 'exportworkspacetodesktop' || requestedAction === 'export_workspace_to_desktop'
            ? 'exportWorkspaceToDesktop'
        : requestedAction === 'exportworkspacetodownloads' || requestedAction === 'export_workspace_to_downloads'
            ? 'exportWorkspaceToDownloads'
        : requestedAction === 'listdesktopdirectory' || requestedAction === 'list_desktop_directory'
            ? 'listDesktopDirectory'
        : requestedAction === 'listdesktopfiles' || requestedAction === 'list_desktop_files'
            ? 'listDesktopDirectory'
        : requestedAction;

    assertServerFileWriteAccess(action);

    if (action === 'createDesktopDirectory') {
        const desktopPath = await resolveLocalDesktopPath(input.path);
        const existingStats = await readExistingPathStats(desktopPath);

        if (existingStats && !existingStats.isDirectory()) {
            const error = new Error(`The requested Desktop path is not a directory: ${input.path}`);
            error.code = 'LOCAL_DESKTOP_PATH_TYPE_MISMATCH';
            error.status = 409;
            throw error;
        }

        await fs.mkdir(desktopPath, {recursive: input.recursive !== false});

        return {
            action,
            path: input.path,
            location: 'local Desktop',
            created: !existingStats,
            existing: Boolean(existingStats),
        };
    }

    if (action === 'deleteDesktopPath') {
        const requestedPath = String(input.path || '').trim();
        const isFileTarget = input.kind === 'file' || input.file === true;
        let desktopPath = await resolveLocalDesktopPath(requestedPath);
        const desktopRoot = path.join(os.homedir(), 'Desktop');

        if (desktopPath === path.resolve(desktopRoot)) {
            throw new Error('The local Desktop root cannot be deleted');
        }

        try {
            const stats = await fs.lstat(desktopPath);
            if (isFileTarget && !stats.isFile()) {
                const typeError = new Error(
                    'The requested Desktop path is not a file: ' + requestedPath,
                );
                typeError.code = 'LOCAL_DESKTOP_PATH_TYPE_MISMATCH';
                typeError.status = 409;
                throw typeError;
            }
        } catch (error) {
            if (error.code !== 'ENOENT' || !isFileTarget) {
                if (error.code === 'ENOENT') {
                    error.code = 'LOCAL_DESKTOP_PATH_NOT_FOUND';
                    error.status = 404;
                    error.message = 'The requested Desktop path was not found: ' + requestedPath;
                }
                throw error;
            }

            const requestedFileName = path.basename(requestedPath);
            const matches = await findLocalDesktopFiles(requestedFileName, input.searchPath);

            if (matches.length === 0) {
                const notFoundError = new Error(
                    'The requested Desktop file was not found: ' + requestedFileName,
                );
                notFoundError.code = 'LOCAL_DESKTOP_FILE_NOT_FOUND';
                notFoundError.status = 404;
                throw notFoundError;
            }

            if (matches.length > 1) {
                const ambiguousError = new Error(
                    'More than one Desktop file matches "' + requestedFileName
                    + '". Specify its project-relative path.',
                );
                ambiguousError.code = 'LOCAL_DESKTOP_FILE_AMBIGUOUS';
                ambiguousError.status = 409;
                throw ambiguousError;
            }

            desktopPath = matches[0];
        }

        await fs.rm(desktopPath, {recursive: !isFileTarget, force: false});

        return {
            action,
            path: path.relative(desktopRoot, desktopPath),
            location: 'local Desktop',
            deleted: true,
        };
    }

    if (action === 'renameDesktopPath') {
        const sourcePath = await resolveLocalDesktopPath(input.path);
        const destinationPath = await resolveLocalDesktopPath(input.destination || input.targetPath);
        const desktopRoot = path.join(os.homedir(), 'Desktop');

        if (sourcePath === path.resolve(desktopRoot) || destinationPath === path.resolve(desktopRoot)) {
            throw new Error('The local Desktop root cannot be renamed');
        }

        const sourceStats = await readExistingPathStats(sourcePath);
        if (!sourceStats) {
            const error = new Error(`The requested Desktop path was not found: ${input.path}`);
            error.code = 'LOCAL_DESKTOP_PATH_NOT_FOUND';
            error.status = 404;
            throw error;
        }

        if (input.kind === 'directory' && !sourceStats.isDirectory()) {
            const error = new Error(`The requested Desktop path is not a directory: ${input.path}`);
            error.code = 'LOCAL_DESKTOP_PATH_TYPE_MISMATCH';
            error.status = 409;
            throw error;
        }

        const destinationStats = await readExistingPathStats(destinationPath);
        if (destinationStats) {
            const error = new Error(`The destination Desktop path already exists: ${input.destination || input.targetPath}`);
            error.code = 'LOCAL_DESKTOP_DESTINATION_EXISTS';
            error.status = 409;
            throw error;
        }

        await fs.rename(sourcePath, destinationPath);

        return {
            action,
            path: path.relative(desktopRoot, sourcePath),
            destination: path.relative(desktopRoot, destinationPath),
            location: 'local Desktop',
            renamed: true,
        };
    }

    if (action === 'listDesktopDirectory') {
        const desktopPath = await resolveLocalDesktopPath(input.path);
        let entries;

        try {
            entries = await fs.readdir(desktopPath, {withFileTypes: true});
        } catch (error) {
            if (error.code === 'ENOENT') {
                if (input.allowMissing !== false) {
                    return {
                        action,
                        path: input.path,
                        location: 'local Desktop',
                        imageOnly: input.imagesOnly === true,
                        missing: true,
                        warning: `Local Desktop asset directory does not exist: ${desktopPath}`,
                        entries: [],
                    };
                }

                throw new Error(`Local Desktop asset directory does not exist: ${desktopPath}`);
            }

            if (error.code === 'ENOTDIR') {
                throw new Error(`Local Desktop asset path is not a directory: ${desktopPath}`);
            }

            throw error;
        }

        const imageOnly = input.imagesOnly === true || requestedAction === 'listdesktopfiles'
            || requestedAction === 'list_desktop_files';
        const imagePattern = /\.(?:png|jpe?g|webp|gif|svg|avif)$/i;
        const filteredEntries = imageOnly
            ? entries.filter((entry) => entry.isFile() && imagePattern.test(entry.name))
            : entries;

        const listedEntries = await Promise.all(filteredEntries.map(async (entry) => {
            const entryPath = path.join(desktopPath, entry.name);
            const stats = entry.isFile() ? await fs.stat(entryPath) : null;

            return {
                name: entry.name,
                type: entry.isDirectory() ? 'directory' : 'file',
                ...(stats ? {size: stats.size} : {}),
            };
        }));

        return {
            action,
            path: input.path,
            location: 'local Desktop',
            imageOnly,
            entries: listedEntries,
        };
    }

    if (action === 'exportWorkspaceToDesktop' || action === 'exportWorkspaceToDownloads') {
        const isDownloadsExport = action === 'exportWorkspaceToDownloads';
        const targetPath = isDownloadsExport
            ? await resolveLocalDownloadsPath(input.path || 'kairo-workflow')
            : await resolveLocalDesktopPath(input.path || 'kairo-ecommerce');
        await fs.mkdir(targetPath, {recursive: true});

        const copiedFiles = [];
        const skippedPaths = [];
        const isDependencyPath = (relativePath) => relativePath
            .split(/[\\/]/)
            .some((segment) => segment === 'node_modules');

        const copyWorkspaceEntry = async (sourcePath, relativePath) => {
            // npm/pnpm/yarn create executable links under node_modules/.bin.
            // Dependencies are reproducible from package.json and lockfiles, so
            // omit the generated directory instead of failing the whole export.
            if (isDependencyPath(relativePath)) {
                skippedPaths.push(relativePath);
                return;
            }

            const sourceStats = await fs.lstat(sourcePath);

            if (sourceStats.isSymbolicLink()) {
                throw new Error(`Workspace symlinks cannot be exported: ${relativePath}`);
            }

            const destinationPath = path.resolve(targetPath, relativePath);
            if (!isPathInside(targetPath, destinationPath)) {
                throw new Error(
                    `Export path must remain inside the local ${isDownloadsExport ? 'Downloads' : 'Desktop'} output folder`,
                );
            }

            await assertRealPathInsideWorkspace(targetPath, destinationPath);

            if (sourceStats.isDirectory()) {
                await fs.mkdir(destinationPath, {recursive: true});
                const children = await fs.readdir(sourcePath, {withFileTypes: true});

                for (const child of children) {
                    await copyWorkspaceEntry(
                        path.join(sourcePath, child.name),
                        path.join(relativePath, child.name),
                    );
                }

                return;
            }

            if (!sourceStats.isFile()) {
                return;
            }

            await fs.mkdir(path.dirname(destinationPath), {recursive: true});
            await fs.copyFile(sourcePath, destinationPath);
            copiedFiles.push(relativePath);
        };

        const workspaceEntries = await fs.readdir(workspacePath, {withFileTypes: true});
        for (const entry of workspaceEntries) {
            await copyWorkspaceEntry(
                path.join(workspacePath, entry.name),
                entry.name,
            );
        }

        return {
            action,
            path: input.path || (isDownloadsExport ? 'kairo-workflow' : 'kairo-ecommerce'),
            location: isDownloadsExport ? 'local Downloads' : 'local Desktop',
            downloaded: isDownloadsExport,
            exported: true,
            files: copiedFiles,
            skipped: skippedPaths,
            dependenciesExcluded: skippedPaths.length > 0,
        };
    }

    if (action === 'createFiles' || action === 'createDesktopFiles') {
        const fileEntries = Array.isArray(input.files)
            ? input.files
            : input.files && typeof input.files === 'object' && !Array.isArray(input.files)
                ? Object.entries(input.files).map(([filePath, content]) => ({path: filePath, content}))
                : [];

        if (!fileEntries.length) {
            throw new Error('createFiles requires a non-empty files array or object');
        }

        const preparedFiles = await Promise.all(fileEntries.map(async (entry) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                throw new Error('Each createFiles entry must be an object');
            }

            const requestedFilePath = entry.path || entry.fileName;
            const targetPath = action === 'createDesktopFiles'
                ? await resolveLocalDesktopPath(requestedFilePath)
                : await resolveWorkspaceFile(workspacePath, requestedFilePath);
            const content = normalizeGeneratedSourceContent(
                resolveContent(entry.content),
                requestedFilePath,
            );
            validateContent(content);

            return {
                requestedFilePath,
                targetPath,
                content,
                mode: String(entry.mode || input.mode || 'create').trim().toLowerCase(),
            };
        }));

        const fileResults = await Promise.all(preparedFiles.map(async (preparedFile) => {
            const {targetPath, content, mode, requestedFilePath} = preparedFile;
            const existingStats = await readExistingPathStats(targetPath);

            if (existingStats && isSkipExistingRequest(input, mode)) {
                if (!existingStats.isFile()) {
                    throw createFileTypeMismatchError(requestedFilePath);
                }

                return {
                    path: requestedFilePath,
                    bytesWritten: 0,
                    existing: true,
                    skipped: true,
                };
            }

            await fs.mkdir(path.dirname(targetPath), {recursive: true});
            await fs.writeFile(targetPath, content, {
                encoding: 'utf8',
                flag: input.overwrite === true || ['write', 'update'].includes(mode) ? 'w' : 'wx',
            });

            return {
                path: requestedFilePath,
                bytesWritten: Buffer.byteLength(content, 'utf8'),
                created: true,
            };
        }));

        return {
            action,
            ...(action === 'createDesktopFiles' ? {location: 'local Desktop'} : {}),
            files: fileResults,
            skipped: fileResults.filter((file) => file.skipped).map((file) => file.path),
        };
    }

    const desktopFileAction = action === 'createDesktopFile';
    if (desktopFileAction && !['create', 'write', 'update', 'append'].includes(input.mode || 'create')) {
        throw new Error('createDesktopFile supports create, write, update, or append through the mode field');
    }

    const filePath = desktopFileAction
        ? await resolveLocalDesktopPath(input.path)
        : await resolveWorkspaceFile(workspacePath, input.path, {
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

    if (action === 'mkdir' || action === 'createDirectory') {
        await fs.mkdir(filePath, {recursive: input.recursive !== false});

        return {
            action: 'createDirectory',
            path: input.path,
            created: true,
        };
    }

    const writeAction = desktopFileAction ? String(input.mode || 'create').trim().toLowerCase() : action;

    if (!['create', 'write', 'update', 'append'].includes(writeAction)) {
        throw new Error(`Unsupported fileManager action: ${action}`);
    }

    const content = normalizeGeneratedSourceContent(resolveContent(input.content), input.path);
    validateContent(content);
    const existingStats = await readExistingPathStats(filePath);
    await fs.mkdir(path.dirname(filePath), {recursive: true});

    if (existingStats && writeAction === 'create' && isSkipExistingRequest(input, writeAction)) {
        if (!existingStats.isFile()) {
            throw createFileTypeMismatchError(input.path);
        }

        return {
            action: desktopFileAction ? 'createDesktopFile' : action,
            path: input.path,
            ...(desktopFileAction ? {location: 'local Desktop'} : {}),
            bytesWritten: 0,
            existing: true,
            skipped: true,
        };
    }

    if (writeAction === 'create') {
        await fs.writeFile(filePath, content, {
            encoding: 'utf8',
            flag: input.overwrite === true ? 'w' : 'wx',
        });
    } else if (writeAction === 'write' || writeAction === 'update') {
        await fs.writeFile(filePath, content, 'utf8');
    } else if (writeAction === 'append') {
        await fs.appendFile(filePath, content, 'utf8');
    }

    return {
        action: desktopFileAction ? 'createDesktopFile' : action,
        path: input.path,
        ...(desktopFileAction ? {location: 'local Desktop'} : {}),
        bytesWritten: Buffer.byteLength(content, 'utf8'),
        created: writeAction === 'create',
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
            'User-Agent': 'KAIRO/1.0',
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
                        'User-Agent': 'KAIRO/1.0',
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

const countSqlPlaceholders = (sql) => {
    let count = 0;
    let quote = null;

    for (let index = 0; index < sql.length; index += 1) {
        const character = sql[index];

        if (quote) {
            if (character === '\\') {
                index += 1;
                continue;
            }

            if (character === quote) {
                if (sql[index + 1] === quote) {
                    index += 1;
                } else {
                    quote = null;
                }
            }

            continue;
        }

        if (character === "'" || character === '"' || character === '`') {
            quote = character;
        } else if (character === '?') {
            count += 1;
        }
    }

    return count;
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

    if (/\$\{[^}]+\}/.test(sql)) {
        throw new Error('SQL string interpolation is not allowed; use ? placeholders');
    }

    if (sql.includes(';')) {
        throw new Error('Multiple SQL statements are not allowed');
    }

    const params = input.params ?? input.parameters ?? [];

    if (!Array.isArray(params)) {
        throw new Error('SQL parameters must be an array');
    }

    if (params.some((parameter) => parameter === undefined)) {
        throw new Error('SQL parameters cannot contain undefined values');
    }

    const placeholderCount = countSqlPlaceholders(sql);

    if (placeholderCount === 0) {
        throw new Error('SQL must contain at least one ? placeholder');
    }

    if (placeholderCount !== params.length) {
        throw new Error(
            `SQL placeholder count (${placeholderCount}) must match parameter count (${params.length})`,
        );
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

const httpRequester = async (input, workspacePath, task, options = {}) => {
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
        signal: options.signal,
        maxContentLength: 5 * 1024 * 1024,
        maxBodyLength: 5 * 1024 * 1024,
        validateStatus: () => true,
    });

    const ok = response.status >= 200 && response.status < 400;
    const allowFailure = input.allowFailure === true || input.expectFailure === true;

    return {
        method,
        url,
        requestHeaders: maskHeaders(headers),
        status: response.status,
        statusText: response.statusText,
        headers: maskHeaders(response.headers),
        data: response.data,
        ok,
        exitCode: ok || allowFailure ? 0 : 1,
        stderr: ok || allowFailure ? '' : `HTTP ${method} ${url} failed with status ${response.status} (${response.statusText || 'Error'}): ${typeof response.data === 'string' ? response.data.slice(0, 500) : JSON.stringify(response.data || {}).slice(0, 500)}`,
    };
};

const parseSshTargets = () => {
    const rawTargets = String(process.env.SSH_TARGETS_JSON || '').trim();

    if (!rawTargets) {
        return {};
    }

    let parsedTargets;

    try {
        parsedTargets = JSON.parse(rawTargets);
    } catch (error) {
        throw new Error('SSH_TARGETS_JSON must contain valid JSON');
    }

    if (!parsedTargets || typeof parsedTargets !== 'object' || Array.isArray(parsedTargets)) {
        throw new Error('SSH_TARGETS_JSON must be a JSON object keyed by target alias');
    }

    return parsedTargets;
};

const getSshTarget = (input) => {
    const targetAlias = String(input.target || input.hostAlias || '').trim();

    if (!targetAlias || !SSH_TARGET_ALIAS_PATTERN.test(targetAlias)) {
        throw new Error('SSH target must be a configured alias such as "staging" or "production"');
    }

    const targets = parseSshTargets();
    const hasTarget = Object.prototype.hasOwnProperty.call(targets, targetAlias);
    const configuredTarget = hasTarget ? targets[targetAlias] : null;

    if (!configuredTarget || typeof configuredTarget !== 'object' || Array.isArray(configuredTarget)) {
        const error = new Error(`SSH target is not configured: ${targetAlias}`);
        error.code = 'SSH_TARGET_NOT_CONFIGURED';
        throw error;
    }

    const host = String(configuredTarget.host || '').trim();
    const user = String(configuredTarget.user || '').trim();
    const port = Number(configuredTarget.port || 22);

    if (!host || /[\s\0/@]/.test(host) || host.startsWith('-')) {
        throw new Error(`SSH target ${targetAlias} has an invalid host configuration`);
    }

    if (!user || !SSH_USER_PATTERN.test(user)) {
        throw new Error(`SSH target ${targetAlias} must define a valid user`);
    }

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`SSH target ${targetAlias} has an invalid port`);
    }

    const identityFile = configuredTarget.identityFile
        ? String(configuredTarget.identityFile).trim()
        : '';
    const knownHostsFile = configuredTarget.knownHostsFile
        ? String(configuredTarget.knownHostsFile).trim()
        : '';

    for (const [name, value] of [['identityFile', identityFile], ['knownHostsFile', knownHostsFile]]) {
        if (value && (!path.isAbsolute(value) || /[\0\n\r]/.test(value))) {
            throw new Error(`SSH target ${targetAlias} has an invalid ${name}`);
        }
    }

    return {
        alias: targetAlias,
        host,
        user,
        port,
        identityFile,
        knownHostsFile,
    };
};

const quoteRemotePath = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

const validateSshCommand = (value) => {
    const command = typeof value === 'string' ? value.trim() : '';

    if (!command) {
        throw new Error('An SSH command is required');
    }

    if (command.length > 4000 || /[\0\n\r;&|`<>$]/.test(command)) {
        throw new Error('SSH commands must be one simple command without shell operators or newlines');
    }

    if (SSH_COMMAND_BLACKLIST_PATTERNS.some((pattern) => pattern.test(command))) {
        throw new Error('SSH command is blocked by the remote execution safety policy');
    }

    return command;
};

const sshRequester = async (input, workspacePath, task, options = {}) => {
    const target = getSshTarget(input);
    const command = validateSshCommand(input.command);
    const remoteCwd = typeof input.cwd === 'string' ? input.cwd.trim() : '';

    if (remoteCwd && (remoteCwd.length > 1000 || /[\0\n\r;&|`<>$]/.test(remoteCwd))) {
        throw new Error('SSH cwd must be a simple remote path without shell operators or newlines');
    }

    const remoteCommand = remoteCwd
        ? `cd -- ${quoteRemotePath(remoteCwd)} && ${command}`
        : command;
    const destination = `${target.user}@${target.host}`;
    const sshArguments = [
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=yes',
        '-o', `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`,
        '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=2',
    ];

    if (target.knownHostsFile) {
        sshArguments.push('-o', `UserKnownHostsFile=${target.knownHostsFile}`);
    }

    if (target.identityFile) {
        sshArguments.push('-o', 'IdentitiesOnly=yes');
        sshArguments.push('-i', target.identityFile);
    }

    sshArguments.push('-p', String(target.port), '--', destination, remoteCommand);

    try {
        const result = await execFileAsync('ssh', sshArguments, {
            cwd: workspacePath,
            timeout: COMMAND_TIMEOUT_MS,
            signal: options.signal,
            maxBuffer: MAX_COMMAND_OUTPUT,
            shell: false,
            env: {
                ...process.env,
                SSH_ASKPASS: '/usr/bin/false',
                SSH_ASKPASS_REQUIRE: 'force',
                DISPLAY: '',
            },
        });

        return {
            target: target.alias,
            host: target.host,
            user: target.user,
            port: target.port,
            cwd: remoteCwd || null,
            command,
            stdout: maskSensitiveData(result.stdout || ''),
            stderr: maskSensitiveData(result.stderr || ''),
            exitCode: 0,
        };
    } catch (error) {
        return {
            target: target.alias,
            host: target.host,
            user: target.user,
            port: target.port,
            cwd: remoteCwd || null,
            command,
            stdout: maskSensitiveData(error.stdout || ''),
            stderr: maskSensitiveData(error.stderr || error.message || 'SSH request failed'),
            exitCode: typeof error.code === 'number' ? error.code : 1,
            timedOut: error.code === 'ETIMEDOUT' || error.killed === true,
        };
    }
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

const isAllowedCommand = (commandName) => (
    SAFE_COMMANDS.has(commandName)
    || VIRTUAL_ENV_COMMAND_PATTERN.test(commandName)
);

const getNodeRuntimePath = async () => {
    const homeDirectory = os.homedir();
    const runtimeDirectories = [
        path.join(homeDirectory, '.asdf', 'shims'),
        path.join(homeDirectory, '.fnm', 'current', 'bin'),
        path.join(homeDirectory, '.local', 'share', 'fnm', 'current', 'bin'),
        path.join(homeDirectory, '.volta', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
    ];

    const versionRoots = [
        path.join(homeDirectory, '.nvm', 'versions', 'node'),
        path.join(homeDirectory, '.local', 'share', 'fnm', 'node-versions'),
    ];

    for (const versionRoot of versionRoots) {
        try {
            const entries = await fs.readdir(versionRoot, {withFileTypes: true});
            const versionDirectories = entries
                .filter((entry) => entry.isDirectory())
                .map((entry) => entry.name)
                .sort()
                .reverse();

            for (const versionDirectory of versionDirectories) {
                runtimeDirectories.unshift(
                    path.join(
                        versionRoot,
                        versionDirectory,
                        versionRoot.endsWith(path.join('fnm', 'node-versions')) ? 'installation' : 'bin',
                    ),
                );
            }
        } catch (_) {
            // A runtime manager is optional. Continue with other known paths.
        }
    }

    return [...new Set([
        ...runtimeDirectories,
        ...(process.env.PATH || '').split(path.delimiter),
    ].filter(Boolean))].join(path.delimiter);
};

const executeCommand = async (input, workspacePath, task, options = {}) => {
    const command = typeof input.command === 'string' ? input.command.trim() : '';

    if (!command) {
        throw new Error('A command is required');
    }

    if (COMMAND_BLACKLIST_PATTERNS.some((pattern) => pattern.test(command))) {
        throw new Error('Command is permanently blocked by the security policy');
    }

    if (/[;&|`]|\$\(|>|<|\n/.test(command)) {
        throw new Error('Shell operators and command chaining are not allowed; run each command as a separate workflow task');
    }

    const [commandName, ...args] = tokenizeCommand(command);

    if (!isAllowedCommand(commandName)) {
        throw new Error(`Command is not allowed: ${commandName}`);
    }

    // Determine target execution directory (supports relative workspace paths or local Desktop output)
    let effectiveCwd = workspacePath;
    const requestedCwd = input.cwd || input.workingDirectory || input.path || input.desktopPath;

    if (typeof requestedCwd === 'string' && requestedCwd.trim()) {
        const trimmed = requestedCwd.trim();
        if (LOCAL_DESKTOP_OUTPUT_ENABLED && (trimmed.toLowerCase().includes('desktop') || input.desktop)) {
            effectiveCwd = await resolveLocalDesktopPath(trimmed);
        } else {
            if (LOCAL_DESKTOP_OUTPUT_ENABLED) {
                try {
                    const desktopCandidate = await resolveLocalDesktopPath(trimmed);
                    const stats = await fs.stat(desktopCandidate);
                    if (stats.isDirectory()) {
                        effectiveCwd = desktopCandidate;
                    }
                } catch (_) {}
            }
            if (effectiveCwd === workspacePath) {
                effectiveCwd = path.resolve(workspacePath, trimmed);
                await assertRealPathInsideWorkspace(workspacePath, effectiveCwd);
            }
        }
    } else if (LOCAL_DESKTOP_OUTPUT_ENABLED && task && (task.run_id || task.runId)) {
        // If this task depends on a previous task in this run that created a Desktop folder, use that folder as cwd
        try {
            const runId = task.run_id || task.runId;
            const [prevTasks] = await databasePool.query(
                "SELECT tool_input FROM task_nodes WHERE run_id = ? AND assigned_tool = 'fileManager' AND status = 'SUCCESS' ORDER BY created_at DESC",
                [runId],
            );
            for (const pt of prevTasks) {
                const parsed = typeof pt.tool_input === 'string' ? JSON.parse(pt.tool_input) : pt.tool_input;
                if (parsed?.action === 'createDesktopDirectory' && parsed?.path) {
                    const desktopCandidate = await resolveLocalDesktopPath(parsed.path);
                    const stats = await fs.stat(desktopCandidate);
                    if (stats.isDirectory()) {
                        effectiveCwd = desktopCandidate;
                        break;
                    }
                }
            }
        } catch (_) {}
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

        // Only enforce file existence check for inspection utilities
        if (['cat', 'head', 'tail', 'grep', 'ls', 'find', 'wc'].includes(commandName)) {
            await assertRealPathInsideWorkspace(
                effectiveCwd,
                path.resolve(effectiveCwd, argument),
            );
        }
    }

    if (commandName === 'mkdir') {
        const allowedMkdirOptions = new Set(['-p', '--parents']);
        const unsupportedOptions = args.filter(
            (argument) => argument.startsWith('-') && !allowedMkdirOptions.has(argument),
        );

        if (unsupportedOptions.length) {
            throw new Error(`Unsupported mkdir option: ${unsupportedOptions[0]}`);
        }

        const directoryArguments = args.filter((argument) => !argument.startsWith('-'));

        if (!directoryArguments.length) {
            throw new Error('mkdir requires at least one relative directory path');
        }

        await Promise.all(directoryArguments.map((argument) => fs.mkdir(
            path.resolve(effectiveCwd, argument),
            {recursive: true},
        )));

        return {
            command,
            stdout: '',
            stderr: '',
            exitCode: 0,
        };
    }

    try {
        const commandPath = await getNodeRuntimePath();
        const result = await execFileAsync(commandName, args, {
            cwd: effectiveCwd,
            timeout: COMMAND_TIMEOUT_MS,
            signal: options.signal,
            maxBuffer: MAX_COMMAND_OUTPUT,
            shell: false,
            env: {
                ...process.env,
                PATH: commandPath,
                npm_config_yes: 'true',
                CI: 'true',
            },
        });

        return {
            command,
            cwd: effectiveCwd,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: 0,
        };
    } catch (error) {
        return {
            command,
            cwd: effectiveCwd,
            stdout: error.stdout || '',
            stderr: error.stderr || error.message,
            exitCode: typeof error.code === 'number' ? error.code : 1,
            timedOut: error.code === 'ETIMEDOUT' || error.killed === true,
        };
    }
};

const imageGenerator = async (input, workspacePath) => {
    return rawImageGenerator(input, workspacePath);
};

const createToolRegistry = (tools = {}) => ({
    fileManager,
    webSearch,
    executeCommand,
    databaseConnector,
    httpRequester,
    sshRequester,
    imageGenerator,
    ...tools,
});

const getExitCode = (result) => {
    return Number.isInteger(result?.exitCode) ? result.exitCode : 0;
};

const createExecutionError = (result, latencyMs) => {
    const diagnostic = [result?.stderr, result?.stdout]
        .filter((value) => typeof value === 'string' && value.trim())
        .join('\n')
        .trim()
        .slice(0, 8000);
    const error = new Error(
        diagnostic || `Task tool exited with code ${getExitCode(result)}`,
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
        result = await tool(input, workspacePath, task, options);
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
    sshRequester,
    resolveDynamicContent,
};
