const { GoogleGenAI } = require('@google/genai');
const {
    normalizeUsage,
    recordExecutionTelemetry,
} = require('../core/telemetry');
const {parseJsonResponse} = require('../utils/jsonParser');
require('./env');

const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

const getAiClient = () => {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
        const error = new Error('GEMINI_API_KEY is not configured in environment properties');
        error.code = 'LLM_UNAVAILABLE';
        error.status = 503;
        throw error;
    }
    return new GoogleGenAI({
        apiKey,
        httpOptions: {
            timeout: LLM_TIMEOUT_MS,
            retryOptions: {
                attempts: 1,
            },
        },
    });
};

const wait = (milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
});

const getErrorCode = (error) => {
    if (Number.isInteger(Number(error?.code))) {
        return Number(error.code);
    }

    if (Number.isInteger(Number(error?.status))) {
        return Number(error.status);
    }

    try {
        const parsedMessage = JSON.parse(error?.message || '{}');
        if (Number.isInteger(Number(parsedMessage.error?.code))) {
            return Number(parsedMessage.error.code);
        }
    } catch (parseError) {
        return null;
    }
    return null;
};

const isRetryableError = (error) => {
    const code = getErrorCode(error);
    if ([404, 408, 429, 500, 502, 503, 504].includes(code)) {
        return true;
    }

    const message = String(error?.message || '').toLowerCase();
    const status = String(error?.status || '').toLowerCase();
    const errorString = `${message} ${status}`;

    return (
        errorString.includes('high demand')
        || errorString.includes('spikes in demand')
        || errorString.includes('temporarily unavailable')
        || errorString.includes('rate limit')
        || errorString.includes('resource_exhausted')
        || errorString.includes('unavailable')
        || errorString.includes('overloaded')
        || errorString.includes('timeout')
        || errorString.includes('econnreset')
        || errorString.includes('etimedout')
        || errorString.includes('503')
        || errorString.includes('429')
        || errorString.includes('500')
    );
};

const isTransientProviderError = (error) => {
    return isRetryableError(error);
};

const configuredTimeout = Number(process.env.LLM_TIMEOUT_MS);
const LLM_TIMEOUT_MS = Number.isInteger(configuredTimeout) && configuredTimeout >= 1000
    ? configuredTimeout
    : 60000;

const configuredMaxModelAttempts = Number(process.env.GEMINI_MAX_MODEL_ATTEMPTS);
const MAX_MODEL_ATTEMPTS = Number.isInteger(configuredMaxModelAttempts)
    && configuredMaxModelAttempts >= 1
    ? Math.min(configuredMaxModelAttempts, 5)
    : 2;

const configuredTransientRetries = Number(process.env.GEMINI_TRANSIENT_RETRIES);
const GEMINI_TRANSIENT_RETRIES = Number.isInteger(configuredTransientRetries)
    && configuredTransientRetries >= 0
    ? Math.min(configuredTransientRetries, 3)
    : 2;

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

const getModelCandidates = (model, maxAttempts = MAX_MODEL_ATTEMPTS) => {
    const candidates = [
        model,
        process.env.GEMINI_MODEL,
        process.env.GEMINI_FALLBACK_MODEL,
        'gemini-2.5-flash',
        'gemini-2.5-flash-lite',
        'gemini-1.5-flash',
        'gemini-3.5-flash',
        'gemini-3.1-flash-lite',
        ...String(process.env.GEMINI_EXTRA_MODELS || '')
            .split(',')
            .map((candidate) => candidate.trim())
            .filter(Boolean),
    ].filter(Boolean);
    return [...new Set(candidates)].slice(0, Math.max(maxAttempts, 4));
};

const createLlmFailure = (lastError, operation = 'Gemini request') => {
    const providerStatus = getErrorCode(lastError);
    let code = 'LLM_UNAVAILABLE';
    let status = 503;
    let message = 'The Gemini service is temporarily unavailable. Please try again.';

    if (providerStatus === 408 || providerStatus === 504) {
        code = 'LLM_TIMEOUT';
        status = 504;
        message = 'The Gemini service did not respond in time. Please try again in a moment.';
    } else if (providerStatus === 429) {
        code = 'LLM_UNAVAILABLE';
        status = 503;
        message = 'The Gemini service is temporarily rate-limited. Please try again shortly.';
    } else if (providerStatus === 404) {
        code = 'LLM_UNAVAILABLE';
        status = 503;
        message = 'The configured Gemini model was not found. Check GEMINI_MODEL and GEMINI_FALLBACK_MODEL.';
    } else if (providerStatus && providerStatus < 500) {
        code = 'LLM_ERROR';
        status = 503;
        message = 'Gemini rejected the request. Check the model configuration and request format.';
    } else if (lastError?.code === 'ENOTFOUND' || lastError?.code === 'EAI_AGAIN') {
        code = 'LLM_UNAVAILABLE';
        status = 503;
        message = 'The Gemini service could not be reached. Check the server network connection and API configuration.';
    }

    const error = new Error(`${operation} failed: ${message}`);
    error.code = code;
    error.status = status;
    error.providerStatus = providerStatus || null;
    error.cause = lastError;
    return error;
};

const generateContentWithRetry = async ({
    model,
    contents,
    config,
    maxModelAttempts = MAX_MODEL_ATTEMPTS,
    timeoutMs = LLM_TIMEOUT_MS,
}) => {
    const ai = getAiClient();
    const models = getModelCandidates(model, Math.max(1, maxModelAttempts));
    let lastError;

    for (const currentModel of models) {
        for (let transientAttempt = 0; transientAttempt <= GEMINI_TRANSIENT_RETRIES; transientAttempt += 1) {
            try {
                return await withTimeout(
                    ai.models.generateContent({
                        model: currentModel,
                        contents,
                        config,
                    }),
                    timeoutMs
                );
            } catch (error) {
                lastError = error;
                const code = getErrorCode(error);
                const canRetrySameModel = isTransientProviderError(error)
                    && transientAttempt < GEMINI_TRANSIENT_RETRIES;

                if (canRetrySameModel) {
                    const delayMs = Math.min(1500, 250 * (2 ** transientAttempt));
                    console.warn(
                        `⚠️ Gemini model '${currentModel}' failed (${code || error.message}). `
                        + `Retrying in ${delayMs}ms (${transientAttempt + 1}/${GEMINI_TRANSIENT_RETRIES})...`,
                    );
                    await wait(delayMs);
                    continue;
                }

                const shouldTryNextModel = isRetryableError(error) || code === 404;
                const hasNextModel = currentModel !== models[models.length - 1];

                console.warn(
                    `⚠️ Gemini model '${currentModel}' failed (${code || error.message}). `
                    + (shouldTryNextModel && hasNextModel ? 'Trying next candidate...' : 'Stopping model retries.'),
                );

                if (shouldTryNextModel && hasNextModel) {
                    await wait(200);
                    break;
                }

                throw error;
            }
        }
    }

    throw createLlmFailure(lastError);
};

const getResponseText = (response) => {
    if (!response) {
        return '';
    }

    if (typeof response.text === 'function') {
        return response.text();
    }
    if (typeof response.text === 'string') {
        return response.text;
    }
    if (response.candidates?.[0]?.content?.parts?.[0]?.text) {
        return response.candidates[0].content.parts[0].text;
    }
    return '';
};

const getResponseUsage = (response) => {
    return normalizeUsage(response?.usageMetadata || response?.usage_metadata || {});
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

/**
 * Real-time token streaming using Server-Sent Events (SSE) or WebSocket.
 * Calls onChunk(chunkText) as tokens arrive, and resolves to fullText upon completion.
 */
const skGeminiStream = async (contents, {model, config, onChunk} = {}) => {
    const ai = getAiClient();
    const models = getModelCandidates(model || process.env.GEMINI_MODEL || DEFAULT_MODEL);
    let lastError;

    for (const currentModel of models) {
        try {
            const stream = await ai.models.generateContentStream({
                model: currentModel,
                contents,
                config,
            });

            let fullText = '';

            for await (const chunk of stream) {
                const chunkText = getResponseText(chunk);
                if (chunkText) {
                    fullText += chunkText;
                    if (typeof onChunk === 'function') {
                        onChunk(chunkText);
                    }
                }
            }

            if (!fullText.trim()) {
                const error = new Error('Gemini returned an empty stream response');
                error.code = 'LLM_EMPTY_RESPONSE';
                throw error;
            }

            return fullText.trim();
        } catch (error) {
            lastError = error;
            const code = getErrorCode(error);
            console.warn(`⚠️ Gemini Stream on model '${currentModel}' failed (${code || error.message}). Trying fallback model...`);

            if (isRetryableError(error)) {
                await wait(200);
            }
        }
    }

    throw createLlmFailure(lastError, 'Gemini stream');
};

const parseImagePart = (imageString) => {
    if (typeof imageString !== 'string') return null;
    const match = imageString.match(/^data:([^;]+);base64,(.+)$/s);
    if (match) {
        return {
            inlineData: {
                mimeType: match[1],
                data: match[2].trim(),
            },
        };
    }
    if (/^[A-Za-z0-9+/=]+$/.test(imageString.trim()) && imageString.length > 50) {
        return {
            inlineData: {
                mimeType: 'image/png',
                data: imageString.trim(),
            },
        };
    }
    return null;
};

const generateStructureClient = async ({
    systemPrompt,
    userPrompt,
    images = [],
    model = process.env.GEMINI_MODEL || DEFAULT_MODEL,
    runId = null,
    io = null,
    maxModelAttempts = MAX_MODEL_ATTEMPTS,
    timeoutMs = LLM_TIMEOUT_MS,
}) => {
    try {
        let contentsPayload;
        if (Array.isArray(images) && images.length > 0) {
            const promptText = `${systemPrompt}\n\nUser Request / Goal:\n${userPrompt}\n\nIMPORTANT: Return ONLY valid JSON matching the schema with no extra prose.`;
            const parts = [{text: promptText}];
            for (const img of images) {
                const part = parseImagePart(img);
                if (part) {
                    parts.push(part);
                }
            }
            contentsPayload = [{role: 'user', parts}];
        } else {
            contentsPayload = `${systemPrompt}\n\nUser Request / Goal:\n${userPrompt}\n\nIMPORTANT: Return ONLY valid JSON matching the schema with no extra prose.`;
        }

        const response = await generateContentWithRetry({
            model,
            contents: contentsPayload,
            config: {
                responseMimeType: 'application/json',
                temperature: 0.2,
            },
            maxModelAttempts,
            timeoutMs,
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
    parseImagePart,
    parseJsonResponse,
    skGemini,
    skGeminiStream,
    generateStructureClient,
    getResponseUsage,
};
