const {generateStructureClient} = require('../configs/llm');
const {
    listTaskNodesByRunId,
    updateTaskNode,
} = require('../models/workflow/workflowModel');
const {secureObject} = require('../validators/commonValidator');
const {createErrorTrace} = require('./selfHealing');
const {emitWorkflowEvent} = require('./telemetry');

const MAX_SELF_HEAL_RETRIES = Math.max(
    0,
    Number.parseInt(process.env.MAX_SELF_HEAL_RETRIES || '3', 10) || 3,
);

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

const buildReflectionPrompt = ({task, errorTrace}) => {
    const lastToolInput = parseJsonValue(task.tool_input || task.toolInput, {});

    return {
        systemPrompt: `
You are the OmniAgent reflection and repair engine.
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
- Do not use shell chaining, shell operators, or unsafe commands.
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
    const descendants = new Set([nodeKey]);
    let changed = true;

    while (changed) {
        changed = false;

        for (const task of tasks) {
            const dependencies = parseJsonValue(task.dependencies, []);

            if (
                !descendants.has(task.node_key)
                && dependencies.some((dependency) => descendants.has(dependency))
            ) {
                descendants.add(task.node_key);
                changed = true;
            }
        }
    }

    return tasks.filter((task) => descendants.has(task.node_key) && task.node_key !== nodeKey);
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

    if (retryCount >= MAX_SELF_HEAL_RETRIES) {
        return markTaskFailedAndSkipDependents({
            runId,
            task,
            errorMessage: `Maximum self-healing retries exceeded (${MAX_SELF_HEAL_RETRIES})`,
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
        });
    } catch (reflectionError) {
        const reflectionTrace = {
            ...errorTrace,
            reflectionError: {
                code: reflectionError.code || 'REFLECTION_LLM_ERROR',
                message: reflectionError.message || 'Reflection LLM invocation failed',
            },
        };

        return markTaskFailedAndSkipDependents({
            runId,
            task,
            errorMessage: `Self-healing reflection failed: ${reflectionError.message}`,
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
            errorMessage: `Invalid corrected tool_input: ${correction.reason}`,
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
    getDependentTasks,
    markTaskFailedAndSkipDependents,
    reflectOnTaskFailure,
};
