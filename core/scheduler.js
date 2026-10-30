const pLimitModule = require('p-limit');

const pLimit = pLimitModule.default || pLimitModule;
const {
    listTaskNodesByRunId,
    updateExecutionRunStatus,
    updateTaskNode,
    getExecutionById,
} = require('../models/workflow/workflowModel');
const {createRiskGate} = require('./riskEvaluation');
const {sendErrorTraceToSelfHealingEngine} = require('./selfHealing');
const {emitWorkflowEvent} = require('./telemetry');

const MAX_CONCURRENT_TASKS = Math.max(
    1,
    Number.parseInt(process.env.MAX_CONCURRENT_TASKS || '4', 10) || 4,
);

const ACTIVE_TASK_STATUSES = [
    'QUEUED',
    'RUNNING',
    'AWAITING_APPROVAL',
];

const CONTINUE_ON_ERROR_PATTERNS = [
    /\bcontinue\s+(?:the\s+)?(?:workflow|run|execution)\s+(?:on|after|despite|even\s+with)\s+(?:an?\s+)?(?:error|failure|failed\s+task)\b/i,
    /\b(?:continue|proceed|keep\s+going|carry\s+on)\b[\s\S]{0,45}\b(?:error|failure|failed\s+task)\b/i,
    /\b(?:skip|ignore)\b[\s\S]{0,20}\b(?:failed|failing|error|failure)\b[\s\S]{0,30}\b(?:task|step|work)\b/i,
    /\b(?:run|execute|complete)\b[\s\S]{0,20}\b(?:remaining|other|independent)\s+(?:tasks?|steps?)\b/i,
    /\bif\b[\s\S]{0,20}\b(?:error|failure|failed)\b[\s\S]{0,45}\b(?:continue|proceed|keep\s+going|skip)\b/i,
    /\b(?:do\s+not|don't|never)\s+(?:stop|abort|halt)\b[\s\S]{0,45}\b(?:error|failure|failed|task|workflow|run)\b/i,
];

const STOP_ON_ERROR_PATTERNS = [
    /\b(?:stop|abort|halt|cancel|fail\s+fast)\b[\s\S]{0,35}\b(?:on|after|when|if)\b[\s\S]{0,35}\b(?:error|failure|failed|task)\b/i,
    /\b(?:stop|abort|halt|cancel)\s+(?:the\s+)?(?:workflow|run|execution)\b/i,
    /\b(?:do\s+not|don't|never)\s+(?:continue|proceed|keep\s+going)\b[\s\S]{0,35}\b(?:error|failure|failed|task)\b/i,
];

const resolveFailurePolicy = ({goalPrompt = '', requestedPolicy = ''} = {}) => {
    const explicitPolicy = String(requestedPolicy || '').trim().toLowerCase();
    if (['continue', 'continue_on_error', 'continue-on-error'].includes(explicitPolicy)) {
        return 'CONTINUE_ON_ERROR';
    }
    if (['stop', 'stop_on_error', 'stop-on-error'].includes(explicitPolicy)) {
        return 'STOP_ON_ERROR';
    }

    const prompt = String(goalPrompt || '').replace(/\s+/g, ' ').trim();
    if (STOP_ON_ERROR_PATTERNS.some((pattern) => pattern.test(prompt))) {
        return 'STOP_ON_ERROR';
    }
    if (CONTINUE_ON_ERROR_PATTERNS.some((pattern) => pattern.test(prompt))) {
        return 'CONTINUE_ON_ERROR';
    }

    // Safe default: destructive or dependent work should not continue after
    // an unrecoverable task failure unless the user explicitly requests it.
    return 'STOP_ON_ERROR';
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

const normalizeTask = (task) => ({
    ...task,
    dependencies: parseJsonValue(task.dependencies, []),
    tool_input: parseJsonValue(task.tool_input, {}),
    tool_output: parseJsonValue(task.tool_output ?? task.toolOutput, null),
});

const emitEvent = (io, runId, event, payload) => {
    emitWorkflowEvent({
        io,
        runId,
        event,
        payload,
    });
};

const finalizeUnfinishedTasks = async (runId, tasks, reason, io) => {
    const unfinishedTasks = tasks.filter((task) => (
        !['SUCCESS', 'COMPLETED', 'FAILED', 'SKIPPED'].includes(task.status)
    ));
    const completedAt = new Date();

    await Promise.all(unfinishedTasks.map(async (task) => {
        const nextStatus = task.status === 'RUNNING' ? 'FAILED' : 'SKIPPED';
        const errorMessage = nextStatus === 'FAILED'
            ? reason
            : `Skipped because the workflow stopped before this task ran. ${reason}`;

        try {
            await updateTaskNode(task.id, {
                status: nextStatus,
                errorMessage,
                completedAt,
            });
        } catch (error) {
            console.error(`❌ [Scheduler] Unable to finalize task ${task.id}:`, error.message);
            return;
        }

        emitEvent(io, runId, nextStatus === 'FAILED' ? 'node_failed' : 'node_skipped', {
            runId,
            taskId: task.id,
            nodeKey: task.node_key,
            status: nextStatus,
            error: errorMessage,
            reason: errorMessage,
        });
    }));
};

const finishRun = async (runId, tasks, io) => {
    const hasFailedTask = tasks.some((task) => ['FAILED', 'SKIPPED'].includes(task.status));
    const finalStatus = hasFailedTask ? 'FAILED' : 'COMPLETED';
    const failedTask = tasks.find((task) => task.status === 'FAILED');
    const failureMessage = failedTask?.error_message
        || failedTask?.errorMessage
        || (hasFailedTask ? 'The workflow stopped before all tasks completed.' : null);

    if (hasFailedTask) {
        await finalizeUnfinishedTasks(
            runId,
            tasks,
            failureMessage || 'A workflow task failed.',
            io,
        );
    }

    await updateExecutionRunStatus(runId, finalStatus);

    emitEvent(io, runId, 'run_finished', {
        runId,
        status: finalStatus,
        ...(failureMessage ? {error: failureMessage, reason: failureMessage} : {}),
        completedAt: new Date(),
    });

    return {
        runId,
        status: finalStatus,
        tasksProcessed: tasks.length,
    };
};

const finalizeTasksAfterSchedulerError = async (runId, error, io) => {
    let tasks = [];

    try {
        tasks = (await listTaskNodesByRunId(runId)).map(normalizeTask);
    } catch (loadError) {
        console.error(`❌ [Scheduler] Unable to load tasks while finalizing Run ${runId}:`, loadError.message);
        return;
    }

    const errorMessage = error?.message || 'The workflow scheduler stopped unexpectedly.';
    const completedAt = new Date();
    const unfinishedTasks = tasks.filter((task) => !['SUCCESS', 'COMPLETED', 'FAILED', 'SKIPPED'].includes(task.status));

    await Promise.all(unfinishedTasks.map(async (task) => {
        try {
            await updateTaskNode(task.id, {
                status: 'FAILED',
                errorMessage,
                completedAt,
            });
        } catch (updateError) {
            console.error(`❌ [Scheduler] Unable to finalize task ${task.id}:`, updateError.message);
            return;
        }

        emitEvent(io, runId, 'node_failed', {
            runId,
            taskId: task.id,
            nodeKey: task.node_key,
            status: 'FAILED',
            error: errorMessage,
            reason: 'The workflow scheduler stopped before this task completed.',
        });
    }));
};

const activeSchedulers = new Map();
const activeRunControllers = new Map();

const isRunCancelled = async (runId, signal) => {
    if (signal?.aborted) return true;
    const run = await getExecutionById(runId);
    return run?.status === 'CANCELLED';
};

const cancelActiveRun = (runId) => {
    const controller = activeRunControllers.get(String(runId));
    if (!controller) return false;
    controller.abort();
    return true;
};

const triggerScheduler = async (runId, options = {}) => {
    if (activeSchedulers.has(runId)) {
        console.log(`⏳ [Scheduler] Run ${runId} is already running an active scheduler. Reusing promise.`);
        return activeSchedulers.get(runId);
    }

    const cancellationController = new AbortController();
    activeRunControllers.set(String(runId), cancellationController);

    const schedulerPromise = (async () => {
    const {
        io = null,
        riskGate = createRiskGate(),
        executor = null,
        selfHealing = sendErrorTraceToSelfHealingEngine,
        failurePolicy = '',
    } = options;

    if (typeof executor !== 'function') {
        const error = new Error('Task executor is not configured');
        error.code = 'EXECUTOR_NOT_CONFIGURED';
        throw error;
    }

    const limit = pLimit(MAX_CONCURRENT_TASKS);
    let tasksProcessed = 0;

    console.log(`\n⚡ [Scheduler 2.0] Evaluating DAG state for Run: ${runId}`);

    try {
        const initialRun = await getExecutionById(runId);
        if (!initialRun || initialRun.status === 'CANCELLED') {
            return {
                runId,
                status: 'CANCELLED',
                tasksProcessed,
            };
        }

        const resolvedFailurePolicy = resolveFailurePolicy({
            goalPrompt: initialRun.goal_prompt || initialRun.goalPrompt || '',
            requestedPolicy: failurePolicy,
        });
        const stopOnError = resolvedFailurePolicy === 'STOP_ON_ERROR';

        console.log(
            `⚙️ [Scheduler] Failure policy for Run ${runId}: ${resolvedFailurePolicy}`,
        );

        await updateExecutionRunStatus(runId, 'RUNNING');

        while (true) {
            if (await isRunCancelled(runId, cancellationController.signal)) {
                return {
                    runId,
                    status: 'CANCELLED',
                    tasksProcessed,
                };
            }

            // The scheduler must evaluate the complete DAG. Reading only the
            // rows with the latest created_at can hide an earlier dependency
            // when task inserts receive different timestamps, causing valid
            // downstream tasks to fail with "Task dependencies could not be resolved".
            const rows = await listTaskNodesByRunId(runId);
            const tasks = rows.map(normalizeTask);

            if (!tasks.length) {
                return {
                    runId,
                    status: 'EMPTY',
                    tasksProcessed: 0,
                };
            }

            const pendingTasks = tasks.filter((task) => task.status === 'PENDING');

            if (!pendingTasks.length) {
                const activeTasks = tasks.filter((task) => ACTIVE_TASK_STATUSES.includes(task.status));

                if (activeTasks.length) {
                    if (activeTasks.some((task) => task.status === 'AWAITING_APPROVAL')) {
                        await updateExecutionRunStatus(runId, 'AWAITING_APPROVAL');
                    }

                    return {
                        runId,
                        status: 'WAITING',
                        tasksProcessed,
                    };
                }

                if (await isRunCancelled(runId, cancellationController.signal)) {
                    return {
                        runId,
                        status: 'CANCELLED',
                        tasksProcessed,
                    };
                }

                return finishRun(runId, tasks, io);
            }

            const successfulNodeKeys = new Set(
                tasks
                    .filter((task) => ['SUCCESS', 'COMPLETED'].includes(task.status))
                    .map((task) => task.node_key),
            );
            const failedNodeKeys = new Set(
                tasks
                    .filter((task) => ['FAILED', 'SKIPPED'].includes(task.status))
                    .map((task) => task.node_key),
            );

            const blockedTasks = pendingTasks.filter((task) => {
                return task.dependencies.some((dependency) => failedNodeKeys.has(dependency));
            });

            if (blockedTasks.length) {
                await Promise.all(blockedTasks.map((task) => updateTaskNode(task.id, {
                    status: 'SKIPPED',
                    errorMessage: 'Skipped because a dependency failed',
                    completedAt: new Date(),
                })));

                blockedTasks.forEach((task) => emitEvent(io, runId, 'node_skipped', {
                    runId,
                    taskId: task.id,
                    nodeKey: task.node_key,
                    reason: 'Skipped because a dependency failed',
                }));

                continue;
            }

            const readyTasks = pendingTasks.filter((task) => {
                return task.dependencies.every((dependency) => successfulNodeKeys.has(dependency));
            });

            if (!readyTasks.length) {
                const activeTasks = tasks.filter((task) => ACTIVE_TASK_STATUSES.includes(task.status));

                if (activeTasks.length) {
                    if (activeTasks.some((task) => task.status === 'AWAITING_APPROVAL')) {
                        await updateExecutionRunStatus(runId, 'AWAITING_APPROVAL');
                    }

                    return {
                        runId,
                        status: 'WAITING',
                        tasksProcessed,
                    };
                }

                await Promise.all(pendingTasks.map((task) => updateTaskNode(task.id, {
                    status: 'FAILED',
                    errorMessage: 'Task dependencies could not be resolved',
                    completedAt: new Date(),
                })));

                continue;
            }

            let batchFailed = false;
            const results = await Promise.all(readyTasks.map((task) => limit(async () => {
                if (await isRunCancelled(runId, cancellationController.signal)) {
                    return 'CANCELLED';
                }

                if (stopOnError && batchFailed) {
                    const completedAt = new Date();
                    const errorMessage = 'Skipped because another task in this batch failed.';

                    await updateTaskNode(task.id, {
                        status: 'SKIPPED',
                        errorMessage,
                        completedAt,
                    });

                    emitEvent(io, runId, 'node_skipped', {
                        runId,
                        taskId: task.id,
                        nodeKey: task.node_key,
                        status: 'SKIPPED',
                        error: errorMessage,
                        reason: errorMessage,
                    });

                    return 'SKIPPED';
                }

                const gateResult = typeof riskGate === 'function'
                    ? await riskGate(task)
                    : {canExecute: true};

                if (await isRunCancelled(runId, cancellationController.signal)) {
                    return 'CANCELLED';
                }

                if (!gateResult?.canExecute) {
                    await updateTaskNode(task.id, {
                        status: 'AWAITING_APPROVAL',
                        errorMessage: gateResult?.reason || 'Human approval is required',
                    });

                    emitEvent(io, runId, 'approval_required', {
                        runId,
                        approvalId: gateResult.approvalId,
                        taskId: task.id,
                        nodeKey: task.node_key,
                        title: task.title,
                        assignedTool: task.assigned_tool,
                        toolInput: task.tool_input,
                        riskLevel: gateResult.riskLevel,
                        reason: gateResult.reason,
                        actionSummary: gateResult.actionSummary,
                    });

                    emitEvent(io, runId, 'node_awaiting_approval', {
                        runId,
                        taskId: task.id,
                        nodeKey: task.node_key,
                    });

                    return 'WAITING';
                }

                const startedAt = new Date();
                await updateTaskNode(task.id, {
                    status: 'RUNNING',
                    startedAt,
                });

                emitEvent(io, runId, 'node_running', {
                    runId,
                    taskId: task.id,
                    nodeKey: task.node_key,
                    title: task.title,
                });

                try {
                    const dependencyOutputs = Object.fromEntries(
                        task.dependencies.map((dependency) => {
                            const dependencyTask = tasks.find((candidate) => candidate.node_key === dependency);
                            return [dependency, dependencyTask?.tool_output ?? null];
                        }),
                    );
                    const taskWithDependencies = {
                        ...task,
                        dependencyOutputs,
                    };
                    const executionResult = await executor(taskWithDependencies, {
                        signal: cancellationController.signal,
                    });
                    const output = executionResult && Object.prototype.hasOwnProperty.call(executionResult, 'outputData')
                        ? executionResult.outputData
                        : executionResult;
                    const telemetry = executionResult?.telemetry || {
                        stdout: output?.stdout || '',
                        stderr: output?.stderr || '',
                        exitCode: Number.isInteger(output?.exitCode) ? output.exitCode : 0,
                        latencyMs: null,
                    };
                    const completedAt = new Date();

                    if (await isRunCancelled(runId, cancellationController.signal)) {
                        await updateTaskNode(task.id, {
                            status: 'SKIPPED',
                            errorMessage: 'Workflow cancelled by user',
                            completedAt,
                        });

                        emitEvent(io, runId, 'node_skipped', {
                            runId,
                            taskId: task.id,
                            nodeKey: task.node_key,
                            reason: 'Workflow cancelled by user',
                        });

                        return 'CANCELLED';
                    }

                    await updateTaskNode(task.id, {
                        status: 'SUCCESS',
                        toolOutput: output ?? null,
                        executionTimeMs: telemetry.latencyMs ?? completedAt.getTime() - startedAt.getTime(),
                        completedAt,
                        errorMessage: null,
                    });

                    emitEvent(io, runId, 'node_success', {
                        runId,
                        taskId: task.id,
                        nodeKey: task.node_key,
                        status: 'SUCCESS',
                        highlight: 'green',
                        outputData: output ?? null,
                        stdout: telemetry.stdout,
                        stderr: telemetry.stderr,
                        exitCode: telemetry.exitCode,
                        latencyMs: telemetry.latencyMs ?? completedAt.getTime() - startedAt.getTime(),
                    });

                    emitEvent(io, runId, 'node_completed', {
                        runId,
                        taskId: task.id,
                        nodeKey: task.node_key,
                    });

                    return 'SUCCESS';
                } catch (error) {
                    const completedAt = new Date();
                    const telemetry = error.execution || {
                        stdout: error.stdout || '',
                        stderr: error.stderr || error.message || 'Task execution failed',
                        exitCode: Number.isInteger(error.code) ? error.code : 1,
                        latencyMs: completedAt.getTime() - startedAt.getTime(),
                    };

                    if (await isRunCancelled(runId, cancellationController.signal)) {
                        await updateTaskNode(task.id, {
                            status: 'SKIPPED',
                            errorMessage: 'Workflow cancelled by user',
                            completedAt,
                        });

                        emitEvent(io, runId, 'node_skipped', {
                            runId,
                            taskId: task.id,
                            nodeKey: task.node_key,
                            reason: 'Workflow cancelled by user',
                        });

                        return 'CANCELLED';
                    }

                    let recovery = null;

                    try {
                        recovery = await selfHealing({
                            runId,
                            task,
                            error,
                            telemetry,
                            io,
                        });
                    } catch (selfHealingError) {
                        console.error(
                            `❌ [Self-Healing Dispatch Error]: ${selfHealingError.message}`,
                        );
                    }

                    if (recovery?.retry) {
                        await updateTaskNode(task.id, {
                            executionTimeMs: telemetry.latencyMs ?? completedAt.getTime() - startedAt.getTime(),
                        });

                        return 'RETRY';
                    }

                    if (stopOnError) {
                        batchFailed = true;
                    }

                    if (!recovery?.finalized) {
                        await updateTaskNode(task.id, {
                            status: 'FAILED',
                            errorMessage: error.message || 'Task execution failed',
                            executionTimeMs: telemetry.latencyMs ?? completedAt.getTime() - startedAt.getTime(),
                            completedAt,
                        });

                        emitEvent(io, runId, 'node_failed', {
                            runId,
                            taskId: task.id,
                            nodeKey: task.node_key,
                            status: 'FAILED',
                            highlight: 'red',
                            error: error.message || 'Task execution failed',
                            stdout: telemetry.stdout,
                            stderr: telemetry.stderr,
                            exitCode: telemetry.exitCode,
                            latencyMs: telemetry.latencyMs ?? completedAt.getTime() - startedAt.getTime(),
                            errorTrace: recovery?.errorTrace || null,
                        });
                    }

                    return 'FAILED';
                }
            })));

            tasksProcessed += results.length;

            if (results.includes('CANCELLED')
                || await isRunCancelled(runId, cancellationController.signal)) {
                return {
                    runId,
                    status: 'CANCELLED',
                    tasksProcessed,
                };
            }

            // Stop-on-error is the safe default for workflow runs. A failed
            // task must not allow unrelated pending tasks to start on the
            // next DAG pass, especially when self-healing is unavailable.
            // Tasks already running in this batch are allowed to settle, then
            // finishRun marks the remaining pending work as SKIPPED.
            if (stopOnError && results.includes('FAILED')) {
                const latestTasks = (await listTaskNodesByRunId(runId)).map(normalizeTask);
                return finishRun(runId, latestTasks, io);
            }

            if (results.includes('WAITING')) {
                await updateExecutionRunStatus(runId, 'AWAITING_APPROVAL');

                return {
                    runId,
                    status: 'WAITING_APPROVAL',
                    tasksProcessed,
                };
            }
        }
    } catch (error) {
        if (cancellationController.signal.aborted || (await isRunCancelled(runId, cancellationController.signal))) {
            return {
                runId,
                status: 'CANCELLED',
                tasksProcessed,
            };
        }

        await finalizeTasksAfterSchedulerError(runId, error, io);
        await updateExecutionRunStatus(runId, 'FAILED');
        emitEvent(io, runId, 'run_finished', {
            runId,
            status: 'FAILED',
            error: error.message || 'The workflow scheduler stopped unexpectedly.',
            completedAt: new Date(),
        });
        console.error(`❌ [Scheduler Error]:`, error.message);
        throw error;
    }
    })();

    activeSchedulers.set(runId, schedulerPromise);
    try {
        return await schedulerPromise;
    } finally {
        activeSchedulers.delete(runId);
        activeRunControllers.delete(String(runId));
    }
};

module.exports = {
    triggerScheduler,
    cancelActiveRun,
};
