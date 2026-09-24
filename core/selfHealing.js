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

/**
 * Publishes a failure trace for a self-healing worker. A future repair worker
 * can subscribe to this event without changing the scheduler's failure path.
 */
const sendErrorTraceToSelfHealingEngine = async ({runId, task, error, telemetry, io}) => {
    const trace = createErrorTrace({runId, task, error, telemetry});

    if (io) {
        io.to(`run_${runId}`).emit('self_healing_required', trace);
        io.to(`run_${runId}`).emit('node_error_trace', trace);
    }

    console.error(
        `🩺 [Self-Healing] Error trace ${trace.traceId} queued for `
        + `Run ${runId}, Node ${trace.nodeKey}: ${trace.error.message}`,
    );

    return trace;
};

module.exports = {
    createErrorTrace,
    sendErrorTraceToSelfHealingEngine,
};
