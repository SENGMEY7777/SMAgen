const crypto = require('crypto');

const approveModel = require('../models/admins/approveModel');
const {containsSensitiveData} = require('../validators/commonValidator');

const RISK_LEVELS = {
    LOW: 1,
    MEDIUM: 2,
    HIGH: 3,
    CRITICAL: 4,
};

const READ_ONLY_ACTIONS = new Set(['read', 'list', 'search', 'get']);
const SAFE_COMMANDS = new Set(['cat', 'head', 'tail', 'grep', 'ls', 'pwd', 'find', 'wc']);
const HIGH_RISK_TOOLS = new Set([
    'databaseConnector',
    'httpRequester',
]);

const DANGEROUS_PATTERNS = [
    /\brm\s+(?:-[a-z]+\s+)*-rf\b/i,
    /\b(?:drop|truncate)\s+(?:database|table|schema)\b/i,
    /\bdelete\s+from\b/i,
    /\bcurl\b[^\n|]*\|\s*(?:sh|bash|zsh)\b/i,
    /\bwget\b[^\n|]*\|\s*(?:sh|bash|zsh)\b/i,
    /\b(?:bash|sh|zsh)\b/i,
    /\bfind\b[^\n]*(?:-exec(?:dir)?|-delete|-ok(?:dir)?)/i,
    /\bgit\s+(?:push|reset\s+--hard|clean\s+-f)/i,
    /\b(?:insert|update|delete|alter|drop|truncate)\s+(?:into|from|table|database|schema)?/i,
    /\beval\s*\(/i,
    /\b(?:sudo|mkfs(?:\.[a-z0-9_-]+)?|shutdown|reboot)\b/i,
    /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?/i,
    /\b(?:nc|ncat|netcat)\b[^\n]*\s-e(?:\s|$)/i,
    /\b(?:bash|sh|zsh)\s+-i(?:\s|$)/i,
];

const parseToolInput = (value) => {
    if (typeof value !== 'string') {
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }

    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
        return {};
    }
};

const getTaskText = (task, input) => {
    return [
        task.title,
        task.instruction,
        task.assigned_tool,
        task.assignedTool,
        input.action,
        input.command,
        input.sql,
        input.script,
        input.query,
        input.url,
    ]
        .filter((value) => value !== undefined && value !== null)
        .join(' ');
};

const evaluateTaskRisk = (task = {}) => {
    const assignedTool = task.assigned_tool || task.assignedTool || '';
    const toolInput = parseToolInput(task.tool_input || task.toolInput);
    const action = String(toolInput.action || '').toLowerCase();
    const taskText = getTaskText(task, toolInput);

    let riskLevel = 'LOW';
    let reason = 'Read-only task can execute automatically';

    if (!assignedTool) {
        riskLevel = 'CRITICAL';
        reason = 'Task does not specify a tool';
    } else if (assignedTool === 'executeCommand') {
        const command = String(toolInput.command || '').trim();
        const commandName = command.split(/\s+/, 1)[0];
        const isSafeReadOnlyGit = /^git\s+(?:status|log|diff|show|branch\s+--show-current|remote(?:\s+-v)?|rev-parse)\b/i.test(command);

        if ((SAFE_COMMANDS.has(commandName) || isSafeReadOnlyGit) && !DANGEROUS_PATTERNS.some((pattern) => pattern.test(command))) {
            riskLevel = 'LOW';
            reason = 'Read-only command can execute automatically';
        } else {
            riskLevel = 'HIGH';
            reason = 'Shell commands require human approval unless they are read-only';
        }
    } else if (HIGH_RISK_TOOLS.has(assignedTool)) {
        riskLevel = 'HIGH';
        reason = `${assignedTool} can access external systems or execute sensitive operations`;
    } else if (assignedTool === 'fileManager' && !READ_ONLY_ACTIONS.has(action)) {
        riskLevel = 'MEDIUM';
        reason = 'File changes require human approval';
    } else if (assignedTool !== 'fileManager' && assignedTool !== 'webSearch') {
        riskLevel = 'HIGH';
        reason = `Tool ${assignedTool} is not on the trusted read-only allowlist`;
    }

    if (DANGEROUS_PATTERNS.some((pattern) => pattern.test(taskText))) {
        riskLevel = 'CRITICAL';
        reason = 'Task contains a potentially destructive or unsafe operation';
    }

    if (containsSensitiveData(JSON.stringify(toolInput))) {
        riskLevel = 'CRITICAL';
        reason = 'Task input appears to contain a secret or credential';
    }

    let actionSummary;
    if (assignedTool === 'executeCommand' && toolInput.command) {
        const cwdContext = toolInput.cwd ? ` (cwd: ${toolInput.cwd})` : '';
        actionSummary = `${String(toolInput.command).trim()}${cwdContext}`.slice(0, 1000);
    } else if (assignedTool === 'fileManager') {
        if (toolInput.path || toolInput.destination) {
            const target = toolInput.destination ? `${toolInput.path || ''} -> ${toolInput.destination}` : toolInput.path;
            actionSummary = `${action || 'fileManager'}: ${target}`.slice(0, 1000);
        } else if (Array.isArray(toolInput.files) && toolInput.files.length) {
            const filePaths = toolInput.files
                .map((entry) => (typeof entry === 'string' ? entry : (entry?.path || entry?.fileName || '')))
                .filter(Boolean);
            const joined = filePaths.join(', ');
            actionSummary = `${action || 'createFiles'}: ${joined || `${toolInput.files.length} files`}`.slice(0, 1000);
        } else if (toolInput.files && typeof toolInput.files === 'object') {
            const filePaths = Object.keys(toolInput.files).filter(Boolean);
            const joined = filePaths.join(', ');
            actionSummary = `${action || 'createFiles'}: ${joined || 'files'}`.slice(0, 1000);
        } else {
            actionSummary = `${action || 'fileManager'}: ${String(
                task.title || task.instruction || 'Unnamed task',
            )}`.slice(0, 1000);
        }
    } else if (assignedTool === 'httpRequester' && toolInput.url) {
        const method = String(toolInput.method || 'GET').toUpperCase();
        actionSummary = `${method} ${toolInput.url}`.slice(0, 1000);
    } else if (assignedTool === 'sshRequester' && toolInput.command) {
        const host = toolInput.target || toolInput.host || 'remote';
        actionSummary = `ssh ${host}: ${String(toolInput.command).trim()}`.slice(0, 1000);
    } else {
        actionSummary = `${assignedTool || 'Unknown tool'} task: ${String(
            task.title || task.instruction || 'Unnamed task',
        ).slice(0, 1000)}`;
    }

    return {
        riskLevel,
        riskScore: RISK_LEVELS[riskLevel],
        requiresApproval: riskLevel !== 'LOW',
        canExecute: riskLevel === 'LOW',
        reason,
        actionSummary,
    };
};

const createRiskGate = ({model = approveModel, idFactory = crypto.randomUUID} = {}) => {
    return async (task) => {
        const evaluation = evaluateTaskRisk(task);

        if (!evaluation.requiresApproval) {
            return evaluation;
        }

        const latestApproval = await model.getLatestApprovalByTaskId(task.id);

        if (latestApproval?.status === 'APPROVED') {
            return {
                ...evaluation,
                canExecute: true,
                reason: 'Approval request was approved',
                approvalId: latestApproval.id,
            };
        }

        if (latestApproval?.status === 'PENDING') {
            return {
                ...evaluation,
                canExecute: false,
                approvalId: latestApproval.id,
                reason: 'Human approval is required',
            };
        }

        const approvalId = idFactory();
        const approval = await model.createApprovalRequest({
            id: approvalId,
            taskId: task.id,
            actionSummary: evaluation.actionSummary,
            riskLevel: evaluation.riskLevel,
        });

        return {
            ...evaluation,
            canExecute: false,
            approvalId,
            approval,
            reason: 'Human approval is required',
        };
    };
};

module.exports = {
    RISK_LEVELS,
    evaluateTaskRisk,
    createRiskGate,
};
