const crypto = require('crypto');

const MAX_TRACE_LENGTH = 10000;

const trimTraceValue = (value) => String(value || '').slice(0, MAX_TRACE_LENGTH);

const createErrorTrace = ({runId, task, error, telemetry = {}}) => ({
    traceId: crypto.randomUUID(),
    runId,
    taskId: task.id,
    nodeKey: task.node_key || task.nodeKey,
    assignedTool: task.assigned_tool || task.assignedTool,
    error: {
        name: error?.name || 'Error',
        code: error?.code || 'TASK_EXECUTION_ERROR',
        message: trimTraceValue(error?.message || 'Task execution failed'),
        stack: trimTraceValue(error?.stack || ''),
    },
    telemetry: {
        stdout: trimTraceValue(telemetry.stdout),
        stderr: trimTraceValue(telemetry.stderr),
        exitCode: Number.isInteger(telemetry.exitCode) ? telemetry.exitCode : 1,
        latencyMs: Number.isFinite(telemetry.latencyMs) ? telemetry.latencyMs : null,
    },
    createdAt: new Date(),
});

const sendErrorTraceToSelfHealingEngine = async ({runId, task, error, telemetry, io}) => {
    const {reflectOnTaskFailure} = require('./reflection');

    return reflectOnTaskFailure({
        runId,
        task,
        error,
        telemetry,
        io,
    });
};

module.exports = {
    createErrorTrace,
    sendErrorTraceToSelfHealingEngine,
};
