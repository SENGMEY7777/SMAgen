const pLimitModule = require('p-limit');

const pLimit = pLimitModule.default || pLimitModule;
const {
    listLatestTaskNodesByRunId,
    updateExecutionRunStatus,
    updateTaskNode,
} = require('../models/workflow/workflowModel');
const {createRiskGate} = require('./riskEvaluation');
const {sendErrorTraceToSelfHealingEngine} = require('./selfHealing');

const MAX_CONCURRENT_TASKS = Math.max(
    1,
    Number.parseInt(process.env.MAX_CONCURRENT_TASKS || '4', 10) || 4,
);

const ACTIVE_TASK_STATUSES = [
    'QUEUED',
    'RUNNING',
    'AWAITING_APPROVAL',
];

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
});

const emitEvent = (io, runId, event, payload) => {
    if (io) {
        io.to(`run_${runId}`).emit(event, payload);
    }
};

const finishRun = async (runId, tasks, io) => {
    const hasFailedTask = tasks.some((task) => ['FAILED', 'SKIPPED'].includes(task.status));
    const finalStatus = hasFailedTask ? 'FAILED' : 'COMPLETED';

    await updateExecutionRunStatus(runId, finalStatus);

    emitEvent(io, runId, 'run_finished', {
        runId,
        status: finalStatus,
        completedAt: new Date(),
    });

    return {
        runId,
        status: finalStatus,
        tasksProcessed: tasks.length,
    };
};

const triggerScheduler = async (runId, options = {}) => {
    const {
        io = null,
        riskGate = createRiskGate(),
        executor = null,
        selfHealing = sendErrorTraceToSelfHealingEngine,
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
        await updateExecutionRunStatus(runId, 'RUNNING');

        while (true) {
            const rows = await listLatestTaskNodesByRunId(runId);
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
                await Promise.all(pendingTasks.map((task) => updateTaskNode(task.id, {
                    status: 'FAILED',
                    errorMessage: 'Task dependencies could not be resolved',
                    completedAt: new Date(),
                })));

                continue;
            }

            const results = await Promise.all(readyTasks.map((task) => limit(async () => {
                const gateResult = typeof riskGate === 'function'
                    ? await riskGate(task)
                    : {canExecute: true};

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
                    const executionResult = await executor(task);
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
        await updateExecutionRunStatus(runId, 'FAILED');
        console.error(`❌ [Scheduler Error]:`, error.message);
        throw error;
    }
};

module.exports = {
    triggerScheduler,
};
