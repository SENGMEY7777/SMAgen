const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

const ai = new GoogleGenAI({
    apiKey: process.env.GOOGLE_API_KEY,
});

const skGemini = async (prompt) => {
    try {
        const response = await ai.models.generateContent({
            model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
            contents: prompt,
        });

        return response.text;
    } catch (error) {
        console.error('❌ Gemini Error:', error.message);
        throw error;
    }
}

const generateStructureClient = async ({systemPrompt, userPrompt, model = process.env.GEMINI_MODEL || 'gemini-2.5-flash'}) => {
    try {
        const response = await ai.models.generateContent({
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

        const rawText = response.text;
        const data = JSON.parse(rawText);

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
