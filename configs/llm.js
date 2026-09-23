const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

const DEFAULT_MODEL = 'gemini-3.6-flash';
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.5-flash-lite';
const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

const ai = new GoogleGenAI({
    apiKey,
});

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
    return [408, 429, 500, 502, 503, 504].includes(getErrorCode(error));
};

const generateContentWithRetry = async ({model, contents, config}) => {
    const models = [...new Set([model || DEFAULT_MODEL, FALLBACK_MODEL])];
    let lastError;

    for (const currentModel of models) {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                return await ai.models.generateContent({
                    model: currentModel,
                    contents,
                    config,
                });
            } catch (error) {
                lastError = error;

                if (!isRetryableError(error)) {
                    throw error;
                }

                const isLastAttempt = attempt === 1;
                const isLastModel = currentModel === models[models.length - 1];

                if (isLastAttempt && isLastModel) {
                    break;
                }

                const delay = (1000 * (2 ** attempt)) + Math.floor(Math.random() * 500);

                console.warn(
                    `⚠️ Gemini ${currentModel} returned ${getErrorCode(error)}. Retrying in ${delay}ms...`,
                );
                await wait(delay);
            }
        }
    }

    const finalError = new Error(
        `Gemini request failed after retries${getErrorCode(lastError) ? ` with status ${getErrorCode(lastError)}` : ''}`,
    );
    finalError.code = getErrorCode(lastError) || 'LLM_ERROR';
    finalError.cause = lastError;
    throw finalError;
};

const getResponseText = (response) => {
    return typeof response.text === 'function' ? response.text() : response.text;
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

const skGemini = async (prompt) => {
    try {
        const response = await generateContentWithRetry({
            model: process.env.GEMINI_MODEL || DEFAULT_MODEL,
            contents: prompt,
        });

        return getResponseText(response);
    } catch (error) {
        console.error('❌ Gemini Error:', error.message);
        throw error;
    }
}

const generateStructureClient = async ({systemPrompt, userPrompt, model = process.env.GEMINI_MODEL || DEFAULT_MODEL}) => {
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
        const data = parseJsonResponse(rawText);

        return {
            data,
            rawText,
        };
    } catch (error) {
        console.error('❌ Gemini Structured JSON Error:', error.message);
        throw error;
    }
};

module.exports = {
    skGemini,
    generateStructureClient,
};
