const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');

const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

/**
 * Tool: imageGenerator
 * Generates an image using Google Imagen 3 with seamless fallback to AI image engine
 * @param {object} input
 * @param {string} input.prompt - Description of the image to generate
 * @param {string} [input.fileName] - Output image filename (e.g. 'hero_banner.png')
 * @param {string} [input.aspectRatio] - '1:1', '16:9', '9:16', '4:3', '3:4'
 * @param {string} workspacePath - Output workspace folder
 */
async function imageGenerator(input, workspacePath) {
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (!prompt) {
        throw new Error('A prompt describing the image to generate is required');
    }

    const rawFileName = typeof input.fileName === 'string' && input.fileName.trim()
        ? input.fileName.trim()
        : `image_${Date.now()}.png`;

    const fileName = rawFileName.endsWith('.png') || rawFileName.endsWith('.jpg') || rawFileName.endsWith('.jpeg')
        ? rawFileName
        : `${rawFileName}.png`;

    const outputPath = path.resolve(workspacePath, fileName);
    const aspectRatio = input.aspectRatio || '1:1';

    // 1. Try Google Imagen 3 if API client is available
    if (ai && ai.models && typeof ai.models.generateImages === 'function') {
        try {
            const validAspectRatios = ['1:1', '16:9', '9:16', '4:3', '3:4'];
            const chosenAspect = validAspectRatios.includes(aspectRatio) ? aspectRatio : '1:1';

            const response = await ai.models.generateImages({
                model: 'imagen-3.0-generate-002',
                prompt,
                config: {
                    numberOfImages: 1,
                    outputMimeType: 'image/png',
                    aspectRatio: chosenAspect,
                },
            });

            const imageBase64 = response?.generatedImages?.[0]?.image?.imageBytes;
            if (imageBase64) {
                await fs.writeFile(outputPath, Buffer.from(imageBase64, 'base64'));
                return {
                    success: true,
                    prompt,
                    fileName,
                    filePath: outputPath,
                    engine: 'Google Imagen 3 (imagen-3.0-generate-002)',
                    imageUrl: `/workspaces/${path.basename(workspacePath)}/${fileName}`,
                };
            }
        } catch (imagenError) {
            console.warn('⚠️ [Imagen 3] Primary attempt error, falling back:', imagenError.message || imagenError);
        }
    }

    // 2. High-Quality Free AI Image Engine Fallback
    try {
        const encodedPrompt = encodeURIComponent(prompt);
        const width = aspectRatio === '16:9' ? 1280 : aspectRatio === '9:16' ? 720 : 1024;
        const height = aspectRatio === '16:9' ? 720 : aspectRatio === '9:16' ? 1280 : 1024;
        const fallbackUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=${width}&height=${height}&nologo=true&enhance=true`;

        const imageRes = await axios.get(fallbackUrl, {
            responseType: 'arraybuffer',
            timeout: 30000,
        });

        await fs.writeFile(outputPath, Buffer.from(imageRes.data));

        return {
            success: true,
            prompt,
            fileName,
            filePath: outputPath,
            engine: 'AI Image Engine (Pollinations)',
            imageUrl: `/workspaces/${path.basename(workspacePath)}/${fileName}`,
        };
    } catch (fallbackError) {
        throw new Error(`Failed to generate image: ${fallbackError.message}`);
    }
}

module.exports = {
    imageGenerator,
};
