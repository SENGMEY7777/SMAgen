const { GoogleGenAI } = require('@google/genai');
const {
    normalizeUsage,
    recordExecutionTelemetry,
} = require('../core/telemetry');
require('./env');

const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.5-flash';

const getAiClient = () => {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
        const error = new Error('GEMINI_API_KEY is not configured in environment properties');
        error.code = 'LLM_UNAVAILABLE';
        error.status = 503;
        throw error;
    }
    return new GoogleGenAI({ apiKey });
};

const wait = (milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
});

const getErrorCode = (error) => {
    if (Number.isInteger(error?.code)) {
        return error.code;
    }

    if (Number.isInteger(error?.status)) {
        return error.status;
    }

    try {
        const parsedMessage = JSON.parse(error?.message || '{}');
        return parsedMessage.error?.code;
    } catch (parseError) {
        return null;
    }
};

const isRetryableError = (error) => {
    const code = getErrorCode(error);
    // 401, 403, 404 are non-retryable fatal errors (bad key or bad model name)
    return [408, 429, 500, 502, 503, 504].includes(code);
};

const configuredTimeout = Number(process.env.LLM_TIMEOUT_MS);
const LLM_TIMEOUT_MS = Number.isInteger(configuredTimeout) && configuredTimeout >= 1000
    ? configuredTimeout
    : 15000;

const withTimeout = (promise, timeoutMs = LLM_TIMEOUT_MS) => {
    let timeoutId;

    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            const timeoutError = new Error(`LLM call timed out after ${timeoutMs}ms`);
            timeoutError.code = 408;
            timeoutError.status = 408;
            reject(timeoutError);
        }, timeoutMs);
    });

    return Promise.race([
        promise,
        timeoutPromise,
    ]).finally(() => clearTimeout(timeoutId));
};

const generateContentWithRetry = async ({model, contents, config}) => {
    const ai = getAiClient();
    const candidates = [
        model,
        process.env.GEMINI_MODEL,
        'gemini-3.8-flash',
        'gemini-3.5-flash',
        'gemini-2.5-flash',
        'gemini-2.0-flash',
        'gemini-1.5-flash',
        FALLBACK_MODEL,
    ].filter(Boolean);
    const models = [...new Set(candidates)];
    let lastError;

    for (const currentModel of models) {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                return await withTimeout(
                    ai.models.generateContent({
                        model: currentModel,
                        contents,
                        config,
                    }),
                    LLM_TIMEOUT_MS
                );
            } catch (error) {
                lastError = error;

                if (!isRetryableError(error)) {
                    // Non-retryable (e.g., 404 model not found) -> break to try next candidate immediately
                    break;
                }

                const isLastAttempt = attempt === 1;
                const isLastModel = currentModel === models[models.length - 1];

                if (isLastAttempt && isLastModel) {
                    break;
                }

                const errorCode = getErrorCode(error);
                const baseDelay = errorCode === 429 ? 2000 : 1000;
                const delay = (baseDelay * (2 ** attempt)) + Math.floor(Math.random() * 300);

                console.warn(
                    `⚠️ Gemini ${currentModel} returned ${errorCode || 'ERROR'}. Retrying in ${delay}ms...`,
                );
                await wait(delay);
            }
        }
    }

    const finalError = new Error(
        `Gemini request failed: ${lastError?.message || 'LLM service unavailable'}`,
    );
    finalError.code = getErrorCode(lastError) || 'LLM_ERROR';
    finalError.cause = lastError;
    throw finalError;
};

const getResponseText = (response) => {
    if (!response) {
        return '';
    }

    return typeof response.text === 'function' ? response.text() : response.text;
};

const getResponseUsage = (response) => {
    return normalizeUsage(response?.usageMetadata || response?.usage_metadata || {});
};

const parseJsonResponse = (rawText) => {
    const text = String(rawText || '')
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

    try {
        return JSON.parse(text);
    } catch (error) {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');

        if (start >= 0 && end > start) {
            return JSON.parse(text.slice(start, end + 1));
        }

        throw error;
    }
};

const skGemini = async (contents, {model, config} = {}) => {
    try {
        const response = await generateContentWithRetry({
            model: model || process.env.GEMINI_MODEL || DEFAULT_MODEL,
            contents,
            config,
        });

        const text = getResponseText(response);

        if (typeof text !== 'string' || !text.trim()) {
            const error = new Error('Gemini returned an empty response');
            error.code = 'LLM_EMPTY_RESPONSE';
            throw error;
        }

        return text.trim();
    } catch (error) {
        console.error('❌ Gemini Error:', error?.message || error);
        throw error;
    }
};

const generateStructureClient = async ({
    systemPrompt,
    userPrompt,
    model = process.env.GEMINI_MODEL || DEFAULT_MODEL,
    runId = null,
    io = null,
}) => {
    try {
        const response = await generateContentWithRetry({
            model,
            contents: [
                {
                    role: 'user',
                    parts: [{text: `${systemPrompt}\n\nUser Request:\n${userPrompt}`}],
                },
            ],
            config: {
                responseMimeType: 'application/json',
                temperature: 0.2,
            },
        });

        const rawText = getResponseText(response);
        const usage = getResponseUsage(response);
        let data;

        try {
            data = parseJsonResponse(rawText);
        } catch (error) {
            if (runId) {
                void recordExecutionTelemetry({
                    runId,
                    io,
                    event: 'llm_completion',
                    source: 'AGENT',
                    level: 'ERROR',
                    isLlmCompletion: true,
                    model,
                    usage,
                    payload: {
                        model,
                        responseLength: String(rawText || '').length,
                        validJson: false,
                    },
                });
            }

            throw error;
        }

        if (runId) {
            void recordExecutionTelemetry({
                runId,
                io,
                event: 'llm_completion',
                source: 'AGENT',
                level: 'INFO',
                isLlmCompletion: true,
                model,
                usage,
                payload: {
                    model,
                    responseLength: String(rawText || '').length,
                    validJson: true,
                },
            });
        }

        return {
            data,
            rawText,
            usage,
            model,
        };
    } catch (error) {
        console.error('❌ Gemini Structured JSON Error:', error.message);
        throw error;
    }
};

module.exports = {
    skGemini,
    generateStructureClient,
    getResponseUsage,
};
