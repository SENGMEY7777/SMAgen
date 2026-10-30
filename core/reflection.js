const {generateStructureClient} = require('../configs/llm');
const {
    listTaskNodesByRunId,
    updateTaskNode,
} = require('../models/workflow/workflowModel');
const {secureObject} = require('../validators/commonValidator');
const {createErrorTrace} = require('./selfHealing');
const {emitWorkflowEvent} = require('./telemetry');

const parseRetryLimit = (value, fallback = 3) => {
    if (value === undefined || value === null || String(value).trim() === '') {
        return fallback;
    }

    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
        return fallback;
    }

    return Math.min(parsed, 5);
};

const MAX_SELF_HEAL_RETRIES = parseRetryLimit(process.env.MAX_SELF_HEAL_RETRIES);
const configuredReflectionTimeout = Number.parseInt(process.env.LLM_REFLECTION_TIMEOUT_MS || '15000', 10);
const REFLECTION_LLM_TIMEOUT_MS = Number.isInteger(configuredReflectionTimeout) && configuredReflectionTimeout >= 1000
    ? configuredReflectionTimeout
    : 15000;

const emitEvent = (io, runId, event, payload) => {
    emitWorkflowEvent({
        io,
        runId,
        event,
        source: 'AGENT',
        payload,
    });
};

const parseJsonValue = (value, fallback) => {
    if (typeof value !== 'string') {
        return value ?? fallback;
    }

    try {
        return JSON.parse(value);
    } catch (error) {
        return fallback;
    }
};

const isPlainObject = (value) => {
    return value !== null
        && typeof value === 'object'
        && !Array.isArray(value);
};

const getRetryCount = (task) => {
    const retryCount = Number(task.retry_count ?? task.retryCount ?? 0);

    return Number.isInteger(retryCount) && retryCount >= 0 ? retryCount : 0;
};

const stableSerialize = (value) => {
    if (Array.isArray(value)) {
        return `[${value.map(stableSerialize).join(',')}]`;
    }

    if (isPlainObject(value)) {
        return `{${Object.keys(value).sort().map((key) => (
            `${JSON.stringify(key)}:${stableSerialize(value[key])}`
        )).join(',')}}`;
    }

    return JSON.stringify(value);
};

const getFailureText = ({error, errorTrace}) => [
    error?.message,
    errorTrace?.error?.message,
    errorTrace?.telemetry?.stderr,
].filter(Boolean).join(' ').toLowerCase();

const getNonRepairableFailureReason = ({task, error, errorTrace}) => {
    const code = String(error?.code || errorTrace?.error?.code || '').toUpperCase();
    const text = getFailureText({error, errorTrace});
    const assignedTool = String(task?.assigned_tool || task?.assignedTool || '').trim();
    const toolInput = parseJsonValue(task?.tool_input || task?.toolInput, {});
    const action = String(toolInput?.action || '').trim().toLowerCase();

    if (assignedTool === 'fileManager' && action === 'deleteDesktopPath') {
        return 'Local file removal is deterministic and does not require AI repair.';
    }

    if (code === 'SERVER_FILE_ACCESS_READ_ONLY' || /server file access is read-only/.test(text)) {
        return 'The server is configured for read-only file access.';
    }

    if (/shell operators and command chaining|permanently blocked by the security policy|security policy/.test(text)) {
        return 'The execution safety policy blocked the command.';
    }

    if (/workspace symlinks cannot be exported|symlinks cannot be exported/.test(text)) {
        return 'The export contains a dependency symlink that cannot be copied safely.';
    }

    if (
        assignedTool === 'sshRequester'
        && /ssh target is not configured|host key verification failed|permission denied|batchmode|could not resolve hostname|connection timed out/.test(text)
    ) {
        return 'SSH configuration or authentication must be corrected manually; automatic repair must not change remote credentials or host trust settings.';
    }

    if (/file already exists|eexist|overwrite.*not permitted|already exists.*overwrite/.test(text)) {
        return 'The requested file or folder already exists, and safe automatic overwrite is not allowed.';
    }

    if (
        assignedTool === 'httpRequester'
        && /(?:\b5\d{2}\b|internal server error|remote server itself)/.test(text)
    ) {
        return 'The remote server returned an internal error; the workflow cannot repair that server without its source code.';
    }

    return '';
};

const buildReflectionPrompt = ({task, errorTrace}) => {
    const lastToolInput = parseJsonValue(task.tool_input || task.toolInput, {});

    return {
        systemPrompt: `
You are the KAIRO reflection and repair engine.
Analyze one failed workflow task and produce a corrected tool_input that can be retried safely.
Return JSON only, using exactly this shape:
{
  "valid": true,
  "toolInput": {},
  "reason": "short explanation"
}

If the error cannot be repaired from the available information, return:
{
  "valid": false,
  "toolInput": {},
  "reason": "why a safe automatic repair is impossible"
}

Rules:
- Keep the assigned tool unchanged.
- Change only toolInput arguments.
- Preserve the task's intended scope and workspace safety restrictions.
- Do not invent credentials, secrets, private keys, or authorization headers.
- Never invent shell commands such as 'check' or 'list'. For directory inspection use 'ls'; for file contents use 'cat' or fileManager action 'read'/'list', preserving exact path and filename case. For Python projects, keep package installation inside the project's virtual environment: use './venv/bin/python -m pip' (or './.venv/bin/python -m pip') when that environment exists. Only use 'python3 -m pip' when no project virtual environment is required. Never replace a virtual-environment command with system pip, '--user', or '--break-system-packages'.
- Use exactly one executable command per executeCommand task. Never use shell chaining (&&, ||, or ;), pipes, redirects, subshells, or newlines; if the failed input contains multiple sequential commands, repair only the current command and let the planner keep the remaining commands as separate dependent tasks.
- For directory creation, use fileManager with action 'createDirectory' and a relative path inside the workspace. Never use an absolute path or '..'.
- When local Desktop output is explicitly enabled and the task targets the host Desktop, use fileManager with action 'createDesktopDirectory' and a relative folder name.
- When listing local Desktop assets, keep the assigned tool as fileManager and use action 'listDesktopDirectory' with a relative path such as 'E-Commerce'; never replace it with executeCommand or an absolute path.
- When the task requests image links or image URLs, keep imageGenerator outputMode as 'url' so generated HTML can reference the remote image directly.
- For multiple Vue components, use fileManager action 'createFiles' with a files array; for one file use action 'create' or 'write'.
- When exporting a completed local-development workspace for Finder, keep fileManager action 'exportWorkspaceToDesktop' with a safe relative Desktop folder such as 'kairo-ecommerce'. For a local Downloads export or an unspecified destination, keep fileManager action 'exportWorkspaceToDownloads' with a safe relative folder such as 'kairo-workflow'.
- For sshRequester, preserve the configured target alias and never add or change passwords, private keys, host keys, user credentials, or SSH configuration. Keep the command to one simple command without shell operators, newlines, or nested SSH/scp/sftp calls. SSH authentication, host-key, and permission failures require manual configuration rather than automatic repair.
- toolInput must be a JSON object, never a string or array.
`,
        userPrompt: JSON.stringify({
            task: {
                nodeKey: task.node_key || task.nodeKey,
                title: task.title,
                instruction: task.instruction,
                assignedTool: task.assigned_tool || task.assignedTool,
            },
            lastArguments: lastToolInput,
            errorTrace,
        }, null, 2),
    };
};

const validateCorrection = (data) => {
    if (!isPlainObject(data) || data.valid !== true) {
        return {
            valid: false,
            reason: data?.reason || 'The reflection engine did not return a valid repair',
        };
    }

    const correctedToolInput = data.toolInput ?? data.tool_input;

    if (!isPlainObject(correctedToolInput)) {
        return {
            valid: false,
            reason: 'The reflection engine returned a non-object toolInput',
        };
    }

    const schemaResult = secureObject({max: 50}).validate(correctedToolInput, {
        abortEarly: false,
        allowUnknown: true,
        convert: false,
    });

    if (schemaResult.error) {
        return {
            valid: false,
            reason: schemaResult.error.details
                .map((detail) => detail.message.replace(/"/g, ''))
                .join(', '),
        };
    }

    return {
        valid: true,
        toolInput: schemaResult.value,
        reason: String(data.reason || 'Corrected tool input generated').slice(0, 2000),
    };
};

const getDependentTasks = (tasks, nodeKey) => {
    const identityToNodeKey = new Map();

    for (const task of tasks) {
        if (task.node_key) identityToNodeKey.set(String(task.node_key), String(task.node_key));
        if (task.id) identityToNodeKey.set(String(task.id), String(task.node_key));
    }

    const rootNodeKey = identityToNodeKey.get(String(nodeKey)) || String(nodeKey);
    const descendants = new Set([rootNodeKey]);
    let changed = true;

    while (changed) {
        changed = false;

        for (const task of tasks) {
            const dependencies = parseJsonValue(task.dependencies, []);
            const normalizedDependencies = Array.isArray(dependencies)
                ? dependencies.map((dependency) => identityToNodeKey.get(String(dependency)) || String(dependency))
                : [];

            if (
                !descendants.has(String(task.node_key))
                && normalizedDependencies.some((dependency) => descendants.has(dependency))
            ) {
                descendants.add(String(task.node_key));
                changed = true;
            }
        }
    }

    return tasks.filter((task) => (
        descendants.has(String(task.node_key))
        && String(task.node_key) !== rootNodeKey
    ));
};

const markTaskFailedAndSkipDependents = async ({
    runId,
    task,
    errorMessage,
    errorTrace,
    executionTimeMs,
    io,
}) => {
    const tasks = await listTaskNodesByRunId(runId);
    const dependentTasks = getDependentTasks(tasks, task.node_key || task.nodeKey);
    const completedAt = new Date();

    await updateTaskNode(task.id, {
        status: 'FAILED',
        errorMessage,
        executionTimeMs,
        completedAt,
    });

    await Promise.all(dependentTasks
        .filter((dependentTask) => !['SUCCESS', 'FAILED', 'SKIPPED'].includes(dependentTask.status))
        .map((dependentTask) => updateTaskNode(dependentTask.id, {
            status: 'SKIPPED',
            errorMessage: `Skipped because dependency ${task.node_key || task.nodeKey} failed`,
            completedAt,
        })));

    for (const dependentTask of dependentTasks) {
        if (['SUCCESS', 'FAILED', 'SKIPPED'].includes(dependentTask.status)) {
            continue;
        }

        emitEvent(io, runId, 'node_skipped', {
            runId,
            taskId: dependentTask.id,
            nodeKey: dependentTask.node_key,
            reason: `Skipped because dependency ${task.node_key || task.nodeKey} failed`,
        });
    }

    emitEvent(io, runId, 'node_failed', {
        runId,
        taskId: task.id,
        nodeKey: task.node_key || task.nodeKey,
        status: 'FAILED',
        highlight: 'red',
        error: errorMessage,
        stdout: errorTrace.telemetry.stdout,
        stderr: errorTrace.telemetry.stderr,
        exitCode: errorTrace.telemetry.exitCode,
        latencyMs: errorTrace.telemetry.latencyMs,
        errorTrace,
    });

    return {
        retry: false,
        finalized: true,
        errorTrace,
    };
};

const reflectOnTaskFailure = async ({runId, task, error, telemetry, io}) => {
    const errorTrace = createErrorTrace({runId, task, error, telemetry});
    const retryCount = getRetryCount(task);

    emitEvent(io, runId, 'self_healing_started', {
        ...errorTrace,
        retryCount,
        maxRetries: MAX_SELF_HEAL_RETRIES,
    });

    emitEvent(io, runId, 'self_healing_required', errorTrace);
    emitEvent(io, runId, 'node_error_trace', errorTrace);

    const nonRepairableReason = getNonRepairableFailureReason({
        task,
        error,
        errorTrace,
    });

    if (nonRepairableReason) {
        emitEvent(io, runId, 'self_healing_skipped', {
            runId,
            taskId: task.id,
            nodeKey: task.node_key || task.nodeKey,
            reason: nonRepairableReason,
            errorTrace,
        });

        return markTaskFailedAndSkipDependents({
            runId,
            task,
            errorMessage: `Self-healing skipped: ${nonRepairableReason}`,
            errorTrace,
            executionTimeMs: telemetry?.latencyMs,
            io,
        });
    }

    if (retryCount >= MAX_SELF_HEAL_RETRIES) {
        const lastFailure = error?.message
            || errorTrace?.error?.message
            || errorTrace?.telemetry?.stderr
            || '';
        const retryExhaustedMessage = `Maximum self-healing retries exceeded (${MAX_SELF_HEAL_RETRIES})`
            + (lastFailure ? `. Last task error: ${lastFailure}` : '');

        return markTaskFailedAndSkipDependents({
            runId,
            task,
            errorMessage: retryExhaustedMessage,
            errorTrace,
            executionTimeMs: telemetry?.latencyMs,
            io,
        });
    }

    const nextRetryCount = retryCount + 1;

    await updateTaskNode(task.id, {
        retryCount: nextRetryCount,
    });

    emitEvent(io, runId, 'self_healing_retry_count_updated', {
        runId,
        taskId: task.id,
        nodeKey: task.node_key || task.nodeKey,
        retryCount: nextRetryCount,
    });

    let reflectionResult;

    try {
        const prompt = buildReflectionPrompt({task, errorTrace});
        reflectionResult = await generateStructureClient({
            ...prompt,
            runId,
            io,
            maxModelAttempts: 1,
            timeoutMs: REFLECTION_LLM_TIMEOUT_MS,
        });
    } catch (reflectionError) {
        const reflectionTrace = {
            ...errorTrace,
            reflectionError: {
                code: reflectionError.code || 'REFLECTION_LLM_ERROR',
                message: reflectionError.message || 'Reflection LLM invocation failed',
            },
        };

        const originalTaskError = error?.message || 'The task execution failed.';
        const repairError = reflectionError?.message || 'The repair service was unavailable.';

        return markTaskFailedAndSkipDependents({
            runId,
            task,
            errorMessage: `Task failed: ${originalTaskError}. Automatic repair was unavailable: ${repairError}`,
            errorTrace: reflectionTrace,
            executionTimeMs: telemetry?.latencyMs,
            io,
        });
    }

    const correction = validateCorrection(reflectionResult?.data);

    if (!correction.valid) {
        return markTaskFailedAndSkipDependents({
            runId,
            task,
            errorMessage: correction.reason || 'Self-healing could not resolve the task failure',
            errorTrace,
            executionTimeMs: telemetry?.latencyMs,
            io,
        });
    }

    const previousToolInput = parseJsonValue(task.tool_input || task.toolInput, {});
    if (stableSerialize(previousToolInput) === stableSerialize(correction.toolInput)) {
        const unchangedReason = 'Self-healing stopped because the proposed tool input is unchanged.';

        emitEvent(io, runId, 'self_healing_skipped', {
            runId,
            taskId: task.id,
            nodeKey: task.node_key || task.nodeKey,
            reason: unchangedReason,
            errorTrace,
        });

        return markTaskFailedAndSkipDependents({
            runId,
            task,
            errorMessage: unchangedReason,
            errorTrace,
            executionTimeMs: telemetry?.latencyMs,
            io,
        });
    }

    await updateTaskNode(task.id, {
        status: 'PENDING',
        toolInput: correction.toolInput,
        retryCount: nextRetryCount,
        errorMessage: null,
        startedAt: null,
        completedAt: null,
    });

    emitEvent(io, runId, 'node_retrying', {
        runId,
        taskId: task.id,
        nodeKey: task.node_key || task.nodeKey,
        status: 'PENDING',
        highlight: 'yellow',
        retryCount: nextRetryCount,
        maxRetries: MAX_SELF_HEAL_RETRIES,
        correctedToolInput: correction.toolInput,
        reason: correction.reason,
        errorTrace,
    });

    console.warn(
        `🔧 [Reflection] Re-queuing Node ${task.node_key || task.nodeKey} `
        + `after retry ${nextRetryCount}/${MAX_SELF_HEAL_RETRIES}`,
    );

    return {
        retry: true,
        finalized: false,
        retryCount: nextRetryCount,
        correctedToolInput: correction.toolInput,
        errorTrace,
    };
};

module.exports = {
    MAX_SELF_HEAL_RETRIES,
    buildReflectionPrompt,
    validateCorrection,
    getNonRepairableFailureReason,
    getDependentTasks,
    markTaskFailedAndSkipDependents,
    reflectOnTaskFailure,
};
