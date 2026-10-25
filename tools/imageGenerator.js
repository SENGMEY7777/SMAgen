const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');

const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';

const getImageDimensions = (aspectRatio) => ({
    width: aspectRatio === '16:9' ? 1280 : aspectRatio === '9:16' ? 720 : 1024,
    height: aspectRatio === '16:9' ? 720
        : aspectRatio === '9:16' ? 1280
            : aspectRatio === '4:3' ? 768
                : aspectRatio === '3:4' ? 1365
                    : 1024,
});

const createRemoteImageUrl = (prompt, aspectRatio) => {
    const {width, height} = getImageDimensions(aspectRatio);
    const encodedPrompt = encodeURIComponent(prompt);

    return `https://image.pollinations.ai/prompt/${encodedPrompt}?width=${width}&height=${height}&nologo=true&enhance=true`;
};

/**
 * Tool: imageGenerator
 * Generates an image using Google Imagen 3 with seamless fallback to AI image engine
 * @param {object} input
 * @param {string} input.prompt - Description of the image to generate
 * @param {string} [input.fileName] - Output image filename (e.g. 'hero_banner.png')
 * @param {string} [input.aspectRatio] - '1:1', '16:9', '9:16', '4:3', '3:4'
 * @param {string} [input.outputMode] - 'file' (default), 'url', or 'both'
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

    if (
        path.basename(fileName) !== fileName
        || fileName.split(/[\\/]/).includes('..')
        || fileName.startsWith('.')
    ) {
        throw new Error('Image fileName must be a simple relative image filename');
    }

    const outputPath = path.resolve(workspacePath, fileName);
    const validAspectRatios = ['1:1', '16:9', '9:16', '4:3', '3:4'];
    const aspectRatio = validAspectRatios.includes(input.aspectRatio) ? input.aspectRatio : '1:1';
    const outputMode = String(input.outputMode || 'file').trim().toLowerCase();

    if (!['file', 'url', 'both'].includes(outputMode)) {
        throw new Error("imageGenerator outputMode must be 'file', 'url', or 'both'");
    }

    const remoteImageUrl = createRemoteImageUrl(prompt, aspectRatio);

    // URL mode is intended for generated HTML and frontend assets. The browser
    // loads the generated image directly from the image provider, so no local
    // Desktop/workspace file is required.
    if (outputMode === 'url') {
        return {
            success: true,
            prompt,
            aspectRatio,
            outputMode,
            engine: 'Pollinations remote image URL',
            imageUrl: remoteImageUrl,
            remoteImageUrl,
        };
    }

    // 1. Try the Gemini image model through generateContent. The older
    // generateImages/Imagen path requires Vertex AI and is not supported by
    // regular Gemini API keys.
    if (ai && ai.models && typeof ai.models.generateContent === 'function') {
        try {
            const response = await ai.models.generateContent({
                model: IMAGE_MODEL,
                contents: prompt,
                config: {
                    responseModalities: ['IMAGE'],
                    responseFormat: {
                        image: {
                            aspectRatio,
                        },
                    },
                },
            });

            const imageBase64 = response?.candidates
                ?.flatMap((candidate) => candidate?.content?.parts || [])
                .find((part) => part?.inlineData?.data)
                ?.inlineData?.data;

            if (imageBase64) {
                await fs.writeFile(outputPath, Buffer.from(imageBase64, 'base64'));
                return {
                    success: true,
                    prompt,
                    fileName,
                    filePath: outputPath,
                    engine: `Gemini image model (${IMAGE_MODEL})`,
                    imageUrl: `/workspaces/${path.basename(workspacePath)}/${fileName}`,
                    ...(outputMode === 'both' ? {remoteImageUrl} : {}),
                };
            }

            throw new Error(`Gemini image model '${IMAGE_MODEL}' returned no image data`);
        } catch (imagenError) {
            console.warn('⚠️ [Gemini image] Primary attempt error, falling back:', imagenError.message || imagenError);
        }
    }

    // 2. High-Quality Free AI Image Engine Fallback
    try {
        const fallbackUrl = remoteImageUrl;

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
            ...(outputMode === 'both' ? {remoteImageUrl} : {}),
        };
    } catch (fallbackError) {
        throw new Error(`Failed to generate image: ${fallbackError.message}`);
    }
}

module.exports = {
    imageGenerator,
};
