const crypto = require('crypto');

const {
    createExecutionLog,
    incrementExecutionRunUsage,
} = require('../models/workflow/workflowModel');

const MAX_STRING_LENGTH = 20000;
const SENSITIVE_KEY_PATTERN = /password|passwd|secret|authorization|bearer|cookie|set-cookie|token|api[-_]?key/i;
const SENSITIVE_VALUE_PATTERNS = [
    /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
    /\bsk-[A-Za-z0-9_-]{8,}\b/g,
    /\b(?:AIza|ghp_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{8,}\b/g,
    /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)? PRIVATE KEY-----/gi,
];

const clampString = (value) => String(value || '').slice(0, MAX_STRING_LENGTH);

const maskSensitiveString = (value) => {
    let masked = clampString(value);

    for (const pattern of SENSITIVE_VALUE_PATTERNS) {
        masked = masked.replace(pattern, '[MASKED]');
    }

    return masked;
};

const maskSensitiveData = (value, depth = 0, seen = new WeakSet()) => {
    if (depth > 8) {
        return '[TRUNCATED]';
    }

    if (value === null || value === undefined) {
        return value;
    }

    if (typeof value === 'string') {
        return maskSensitiveString(value);
    }

    if (typeof value !== 'object') {
        return value;
    }

    if (value instanceof Date) {
        return value.toISOString();
    }

    if (seen.has(value)) {
        return '[CIRCULAR]';
    }

    seen.add(value);

    if (Array.isArray(value)) {
        return value.map((item) => maskSensitiveData(item, depth + 1, seen));
    }

    return Object.fromEntries(Object.entries(value).map(([key, childValue]) => {
        if (SENSITIVE_KEY_PATTERN.test(key)) {
            return [key, '[MASKED]'];
        }

        return [key, maskSensitiveData(childValue, depth + 1, seen)];
    }));
};

const normalizeUsage = (usage = {}) => {
    const promptTokens = Math.max(0, Number.parseInt(
        usage.promptTokens ?? usage.promptTokenCount ?? usage.inputTokens ?? 0,
        10,
    ) || 0);
    const completionTokens = Math.max(0, Number.parseInt(
        usage.completionTokens ?? usage.candidatesTokenCount ?? usage.outputTokens ?? 0,
        10,
    ) || 0);
    const totalTokens = Math.max(
        promptTokens + completionTokens,
        Number.parseInt(usage.totalTokens ?? usage.totalTokenCount ?? 0, 10) || 0,
    );

    return {
        promptTokens,
        completionTokens,
        totalTokens,
    };
};

const getRatePerMillionTokens = (primaryKey, fallbackKey) => {
    const value = process.env[primaryKey] ?? process.env[fallbackKey] ?? '0';
    const rate = Number(value);

    return Number.isFinite(rate) && rate >= 0 ? rate : 0;
};

const calculateLlmCost = ({usage = {}, model = null} = {}) => {
    const normalizedUsage = normalizeUsage(usage);
    const inputRateUsdPer1M = getRatePerMillionTokens(
        'GEMINI_INPUT_RATE_USD_PER_1M_TOKENS',
        'LLM_INPUT_RATE_USD_PER_1M_TOKENS',
    );
    const outputRateUsdPer1M = getRatePerMillionTokens(
        'GEMINI_OUTPUT_RATE_USD_PER_1M_TOKENS',
        'LLM_OUTPUT_RATE_USD_PER_1M_TOKENS',
    );
    const inputCostUsd = (normalizedUsage.promptTokens / 1_000_000) * inputRateUsdPer1M;
    const outputCostUsd = (normalizedUsage.completionTokens / 1_000_000) * outputRateUsdPer1M;

    return {
        model,
        inputRateUsdPer1M,
        outputRateUsdPer1M,
        inputCostUsd,
        outputCostUsd,
        totalCostUsd: inputCostUsd + outputCostUsd,
    };
};

const getEventLevel = (event) => {
    if (/failed|error/i.test(event)) {
        return 'ERROR';
    }

    if (/approval|retry|skipped|waiting/i.test(event)) {
        return 'WARN';
    }

    return 'INFO';
};

const getEventSource = (event, isLlmCompletion) => {
    if (isLlmCompletion) {
        return 'AGENT';
    }

    if (/approval/i.test(event)) {
        return 'HITL';
    }

    if (/node_|tool|sandbox/i.test(event)) {
        return 'TOOL';
    }

    return 'SYSTEM';
};

const createTelemetryEnvelope = ({
    runId,
    event,
    payload = null,
    source,
    level,
    isLlmCompletion = false,
    usage = {},
    model = null,
}) => {
    const safePayload = maskSensitiveData(payload);
    const normalizedUsage = normalizeUsage(usage);
    const cost = isLlmCompletion
        ? calculateLlmCost({usage: normalizedUsage, model})
        : {
            model: null,
            inputRateUsdPer1M: 0,
            outputRateUsdPer1M: 0,
            inputCostUsd: 0,
            outputCostUsd: 0,
            totalCostUsd: 0,
        };

    return {
        telemetryId: crypto.randomUUID(),
        runId,
        event,
        type: isLlmCompletion ? 'llm_completion' : 'workflow_event',
        source: source || getEventSource(event, isLlmCompletion),
        level: level || getEventLevel(event),
        createdAt: new Date(),
        payload: safePayload,
        usage: normalizedUsage,
        cost,
    };
};

const recordExecutionTelemetry = async ({
    runId,
    event,
    payload = null,
    io = null,
    source,
    level,
    isLlmCompletion = false,
    usage = {},
    model = null,
}) => {
    const envelope = createTelemetryEnvelope({
        runId,
        event,
        payload,
        source,
        level,
        isLlmCompletion,
        usage,
        model,
    });
    const message = JSON.stringify({
        event: envelope.event,
        type: envelope.type,
        payload: envelope.payload,
        usage: envelope.usage,
        cost: envelope.cost,
    });

    try {
        await createExecutionLog({
            id: envelope.telemetryId,
            runId,
            level: envelope.level,
            source: envelope.source,
            message,
        });

        if (isLlmCompletion) {
            await incrementExecutionRunUsage(runId, {
                totalTokens: envelope.usage.totalTokens,
                totalCostUsd: envelope.cost.totalCostUsd,
            });
        }
    } catch (error) {
        console.error(`❌ [Telemetry Persistence Error]: ${error.message}`);
    }

    if (io) {
        io.to(`run_${runId}`).emit('telemetry', envelope);
    }

    return envelope;
};

const emitWorkflowEvent = ({io, runId, event, payload = null, source, level}) => {
    if (io) {
        io.to(`run_${runId}`).emit(event, maskSensitiveData(payload));
    }

    void recordExecutionTelemetry({
        runId,
        event,
        payload,
        source,
        level,
        io,
    });
};

module.exports = {
    maskSensitiveData,
    normalizeUsage,
    calculateLlmCost,
    createTelemetryEnvelope,
    recordExecutionTelemetry,
    emitWorkflowEvent,
};
