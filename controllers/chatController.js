const crypto = require('crypto');
const {skGemini, skGeminiStream} = require('../configs/llm');
const {executeTaskNode} = require('../core/executor');
const sendResponse = require('../utils/responseHelper');
const logger = require('../utils/logger');

const MAX_HISTORY_MESSAGES = 12;
const CHAT_MAX_OUTPUT_TOKENS = 8192;
const IMAGE_REQUEST_PATTERN = /\b(?:generate|create|draw|design|make|render)\b[\s\S]{0,120}\b(?:image|logo|icon|banner|illustration|artwork|picture|poster)\b/i;

const CHAT_SYSTEM_INSTRUCTION = "You are **KAIRO**, an elite AI Technical Lead, Principal Systems Architect, and Staff Engineer. Whenever you mention your name, always format it in bold as **KAIRO**.\n\n### 👤 Identity, Origin & Creator / Founder:\n- When greeted (e.g. \"Hi\", \"Hello\") or explicitly asked \"Who are you?\", introduce yourself exactly as follows:\n\"Hello! I am **KAIRO**, an elite AI Technical Lead, Principal Systems Architect, and Autonomous Workflow Orchestrator designed and engineered by **Vann Sengmey** (Lead Software Engineer & Systems Architect).\n\nI operate at the intersection of distributed systems, database internals, and cloud infrastructure. My mission is to deliver production-ready code, architect resilient systems, and autonomously execute complex multi-step workflows with zero fluff and maximum technical precision.\n\n**How can I assist you with your architecture or systems design today?**\"\n\n- **When asked \"Who is your founder?\", \"Who created you?\", \"Who built you?\", or \"Who is your developer?\":** Answer directly without mentioning age:\n\"I was designed and engineered by **Vann Sengmey** (Lead Software Engineer & Systems Architect).\"\n\n- **When asked \"How old is your founder?\" or about his age:** Respond with:\n\"My founder, **Vann Sengmey**, is **22 years old**—an ambitious Lead Software Engineer and Systems Architect who engineered my autonomous workflow engine and distributed systems architecture.\"\n\n- For regular technical queries, provide direct, deep, masterclass answers without repeating the introductory monologue.\n\n---\n\n### 🏆 The 10/10 Masterclass Technical Standard:\nYour mission is to deliver authoritative, elegant, and uncompromising 10/10 masterclass technical explanations that score a perfect 10/10 across all evaluation metrics:\n1. **Technical Depth & Accuracy (10/10):** Explain exact kernel/runtime mechanisms, memory models, CPU scheduling, I/O multiplexing, and storage primitives. Never oversimplify.\n2. **Production-Ready Code (10/10):** Whenever code, APIs, schemas, or configs are requested or relevant, provide the **complete, executable, production-grade code** (with error handling, timeouts/cancellation via AbortController, backpressure/streams, and graceful shutdown). Never use snippets, placeholders, or omit code.\n3. **Structured Architectural Breakdown (10/10):** Use clear markdown tables, pipeline diagrams, and side-by-side trade-off matrices.\n4. **Systems Trade-offs (10/10):** Honestly assess strengths, inherent failure modes/bottlenecks, and concrete production mitigations.\n5. **Production Operations Playbook (10/10):** Include Day-2 engineering guidance (kernel/runtime tuning, clustering, connection pooling, indexing, observability).\n\n---\n\n### 🌟 10/10 Response Blueprint:\n\n- **Concept Definition & Core Intuition (Natural Text, NO meta-headings):**\n  - Begin directly with **[Concept Name]** in bold with an authoritative 1–2 sentence definition.\n  - Follow immediately with a brief, vivid intuition or real-world systems mental model.\n\n- **1. Production-Grade Implementation / Schema Script (When code/schema is applicable):**\n  - Provide complete, drop-in, production-ready code (e.g., Full SQL DDL with constraints, or complete Node.js/Java/Go implementations with connection lifecycles and error boundaries).\n\n- **2. Under The Hood: Core Mechanics & Storage / Kernel Primitives:**\n  - Numbered pipeline steps detailing exact execution flow, memory allocations, data structures, and engine internals.\n\n- **3. Comparative Architecture Matrix:**\n  - Clean Markdown comparison table contrasting this technology against alternative architectures (Concurrency model, memory per connection, context switching, throughput).\n\n- **4. Primary Strengths & Inherent Bottlenecks:**\n  - #### 🚀 Strengths: Scalability, throughput, operational simplicity.\n  - #### ⚠️ Inherent Limitations & Mitigations: Bottlenecks (e.g. CPU blocking, GC pauses, lock contention) and their concrete engineering mitigations.\n\n- **5. Production Engineering Playbook:**\n  - Practical Day-2 production configuration: kernel parameters, process clustering, thread pool tuning, heap limits, and metrics.\n\n---\n\n### 🖋️ Tone & Formatting Rules:\n- **No Meta-Labels:** Never output labels like \"Opening Definition:\", \"30-Second Mental Model:\", or \"Section Header:\".\n- **Zero Fluff:** Dive immediately into technical reality.\n- **Section Dividers:** Separate major sections with horizontal rules (---).\n- **Strictly No Token Masks or Placeholders:** NEVER output placeholder masks, token markers, or fill-in-the-blank tokens such as ___TK0___, ___TK1___, ___TK___, [TODO], or <FILL>. Always write the actual, real programming language keywords (e.g. if, catch, try, return, throw, const), complete identifiers, and full production logic.";

const sanitizeChatResponse = (text) => {
    if (typeof text !== 'string') return text;
    return text
        .replace(/___TK1___\s*\(/g, 'if (')
        .replace(/___TK0___\s*\(/g, 'catch (')
        .replace(/___TK\d*___/g, '');
};

const buildConversationRequest = ({message, history = []}) => {
    const contents = history
        .slice(-MAX_HISTORY_MESSAGES)
        .filter((entry) => (
            entry
            && ['user', 'assistant'].includes(entry.role)
            && typeof entry.content === 'string'
            && entry.content.trim()
        ))
        .map(({role, content}) => ({
            role: role === 'assistant' ? 'model' : 'user',
            parts: [{text: content.trim()}],
        }));

    contents.push({
        role: 'user',
        parts: [{text: message.trim()}],
    });

    return {
        contents,
        config: {
            systemInstruction: CHAT_SYSTEM_INSTRUCTION,
            temperature: 0.2,
            maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS,
        },
    };
};

const isImageGenerationRequest = (message) => IMAGE_REQUEST_PATTERN.test(String(message || ''));
const wantsRemoteImageUrl = (message) => /\b(?:image|photo|picture|banner)\b[\s\S]{0,80}\b(?:url|urls|link|links|remote|external|cdn)\b|\b(?:image\s+)?(?:url|urls|link|links)\b/i.test(String(message || ''));

const generateChatImage = async (message) => {
    const runId = `chat-${crypto.randomUUID()}`;
    const fileName = 'generated-image.png';
    const execution = await executeTaskNode({
        runId,
        assignedTool: 'imageGenerator',
        toolInput: {
            prompt: message.trim(),
            fileName,
            aspectRatio: '1:1',
            ...(wantsRemoteImageUrl(message) ? {outputMode: 'url'} : {}),
        },
    });
    const output = execution?.outputData || {};

    if (!output.imageUrl) {
        throw new Error('The image generator did not return an image URL');
    }

    return {
        runId,
        fileName: output.fileName || fileName,
        imageUrl: output.imageUrl,
        engine: output.engine || 'Image generator',
        message: `![Generated image](${output.imageUrl})\n\nGenerated with ${output.engine || 'the KAIRO image generator'}.`,
    };
};

/**
 * Standard batch JSON chat response.
 */
const chat = async (req, res, next) => {
    // If client requested stream via query param (?stream=true) or SSE accept header
    if (req.query.stream === 'true' || req.headers.accept === 'text/event-stream') {
        return chatStream(req, res);
    }

    try {
        const {message, history = []} = req.body || {};
        if (typeof message !== 'string' || !message.trim()) {
            return sendResponse(res, 400, false, 'A chat message is required', null, {
                code: 'VALIDATION_ERROR',
            });
        }

        if (!Array.isArray(history)) {
            return sendResponse(res, 400, false, 'Chat history must be an array', null, {
                code: 'VALIDATION_ERROR',
            });
        }

        if (isImageGenerationRequest(message)) {
            const image = await generateChatImage(message);
            return sendResponse(res, 200, true, 'Image generated successfully', {
                message: image.message,
                mode: 'image',
                image,
            });
        }

        const {contents, config} = buildConversationRequest({message, history});
        const answer = await skGemini(contents, {config});

        return sendResponse(res, 200, true, 'Chat response generated', {
            message: sanitizeChatResponse(answer),
            mode: 'chat',
        });
    } catch (error) {
        return next(error);
    }
};

/**
 * Live Real-Time Token Streaming using Server-Sent Events (SSE).
 * Sends token chunks immediately as they arrive from Google Gemini.
 */
const chatStream = async (req, res) => {
    const {message, history = []} = req.body || {};

    if (typeof message !== 'string' || !message.trim()) {
        return sendResponse(res, 400, false, 'A chat message is required', null, {
            code: 'VALIDATION_ERROR',
        });
    }

    // Set Server-Sent Events (SSE) headers with Nginx unbuffered streaming header
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no', // Critical: tells Nginx not to buffer chunks
    });

    res.flushHeaders?.();

    // Send connection established event
    res.write(`data: ${JSON.stringify({ event: 'start', timestamp: new Date().toISOString() })}\n\n`);

    try {
        if (isImageGenerationRequest(message)) {
            const image = await generateChatImage(message);
            res.write(`data: ${JSON.stringify({ event: 'chunk', text: image.message, done: false })}\n\n`);
            res.write(`data: ${JSON.stringify({
                event: 'done',
                text: '',
                done: true,
                fullText: image.message,
                image,
            })}\n\n`);
            return res.end();
        }

        const {contents, config} = buildConversationRequest({message, history});

        const fullText = await skGeminiStream(contents, {
            config,
            onChunk: (chunkText) => {
                res.write(`data: ${JSON.stringify({ event: 'chunk', text: sanitizeChatResponse(chunkText), done: false })}\n\n`);
            },
        });

        // Final completion event
        res.write(`data: ${JSON.stringify({ event: 'done', text: '', done: true, fullText: sanitizeChatResponse(fullText) })}\n\n`);
        res.end();
    } catch (error) {
        logger.error('Chat stream error', error);
        res.write(`data: ${JSON.stringify({ event: 'error', error: error?.message || 'Streaming failed', done: true })}\n\n`);
        res.end();
    }
};

module.exports = {
    chat,
    chatStream,
    buildConversationRequest,
    isImageGenerationRequest,
};
