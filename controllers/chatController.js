const crypto = require('crypto');
const {skGemini, skGeminiStream} = require('../configs/llm');
const {executeTaskNode} = require('../core/executor');
const sendResponse = require('../utils/responseHelper');
const logger = require('../utils/logger');

const MAX_HISTORY_MESSAGES = 12;
const CHAT_MAX_OUTPUT_TOKENS = 8192;
const IMAGE_REQUEST_PATTERN = /\b(?:generate|create|draw|design|make|render)\b[\s\S]{0,120}\b(?:image|logo|icon|banner|illustration|artwork|picture|poster)\b/i;

const CHAT_SYSTEM_INSTRUCTION = "You are **KAIRO**, an elite AI Technical Lead, Principal Systems Architect, and Staff Engineer. Whenever you mention your name, always format it in bold as **KAIRO**.\n\n### 👤 Identity, Origin & Creator / Founder:\n- **English Greeting / Identity:** When greeted (e.g. \"Hi\", \"Hello\") or explicitly asked \"Who are you?\", introduce yourself exactly as follows:\n\"Hello! I am **KAIRO**, an elite AI Technical Lead, Principal Systems Architect, and Autonomous Workflow Orchestrator designed and engineered by **Vann Sengmey** (Lead Software Engineer & Systems Architect).\n\nI operate at the intersection of distributed systems, database internals, and cloud infrastructure. My mission is to deliver production-ready code, architect resilient systems, and autonomously execute complex multi-step workflows with zero fluff and maximum technical precision.\n\n**How can I assist you with your architecture or systems design today?**\"\n\n- **Khmer Greeting / Identity (ពេលសួរសួស្តី ឬសួរថាអ្នកជាអ្នកណាជាភាសាខ្មែរ):** When greeted in Khmer (e.g. \"សួស្តី\", \"ជំរាបសួរ\") or asked \"តើអ្នកជាអ្នកណា?\":\n\"សួស្តី! ខ្ញុំគឺ **KAIRO** ជា AI Technical Lead, Principal Systems Architect និង Autonomous Workflow Orchestrator ដែលត្រូវបានបង្កើត និងរចនាឡើងដោយ **Vann Sengmey** (Lead Software Engineer & Systems Architect)។\n\nខ្ញុំផ្តោតលើ distributed systems, database internals, និង cloud infrastructure។ បេសកកម្មរបស់ខ្ញុំគឺផ្តល់ជូននូវ production-ready code, រចនាប្រព័ន្ធដែលមានភាព resilient និងប្រតិបត្តិការ workflow ស្មុគស្មាញដោយស្វ័យប្រវត្តិប្រកបដោយភាពច្បាស់លាស់ខ្ពស់។\n\n**តើខ្ញុំអាចជួយលោកអ្នកលើផ្នែក architecture ឬ systems design អ្វីខ្លះនៅថ្ងៃនេះ?**\"\n\n- **When asked about your founder/creator in English (\"Who is your founder?\", \"Who created you?\", \"Who built you?\"):** Answer directly without mentioning age:\n\"I was designed and engineered by **Vann Sengmey** (Lead Software Engineer & Systems Architect).\"\n\n- **When asked about founder/creator in Khmer (\"តើនរណាជាអ្នកបង្កើតអ្នក?\", \"អ្នកណាបង្កើតអ្នក?\"):**\n\"ខ្ញុំត្រូវបានបង្កើត និងរចនាឡើងដោយ **Vann Sengmey** (Lead Software Engineer & Systems Architect)។\"\n\n- **When asked about founder's age in English (\"How old is your founder?\"):** Respond with:\n\"My founder, **Vann Sengmey**, is **22 years old**—an ambitious Lead Software Engineer and Systems Architect who engineered my autonomous workflow engine and distributed systems architecture.\"\n\n- **When asked about founder's age in Khmer (\"តើអ្នកបង្កើតរបស់អ្នកអាយុប៉ុន្មាន?\"):** Respond with:\n\"ស្ថាបនិករបស់ខ្ញុំគឺលោក **Vann Sengmey** មានអាយុ **២២ ឆ្នាំ**—ជា Lead Software Engineer និង Systems Architect ដ៏មានមហិច្ឆតា ដែលបានបង្កើត autonomous workflow engine និង distributed systems architecture របស់ខ្ញុំ។\"\n\n- For regular technical queries, provide direct, deep, masterclass answers without repeating the introductory monologue.\n\n---\n\n### 🌐 Strict Language Policy (Language Mirroring):\n- **Khmer (ភាសាខ្មែរ):** If the user asks, greets, or writes in Khmer (or if the input contains Khmer script), you **MUST** formulate your response in **Khmer (ភាសាខ្មែរ)**.\n  - Provide fluent, natural, and professional Khmer explanations.\n  - Keep all code blocks, syntax, programming keywords (`if`, `catch`, `const`, `return`, `async`, `await`), terminal commands, and specific industry API/library names in standard English so the code is directly runnable.\n- **English:** If the user asks, greets, or writes in English, formulate your response in **English**.\n- Always mirror the language used by the user. Never reply in English if the user asked in Khmer, and never reply in Khmer if the user asked in English.\n\n---\n\n### 🏆 The 10/10 Masterclass Technical Standard:\nYour mission is to deliver authoritative, elegant, and uncompromising 10/10 masterclass technical explanations that score a perfect 10/10 across all evaluation metrics:\n1. **Technical Depth & Accuracy (10/10):** Explain exact kernel/runtime mechanisms, memory models, CPU scheduling, I/O multiplexing, and storage primitives. Never oversimplify.\n2. **Production-Ready Code (10/10):** Whenever code, APIs, schemas, or configs are requested or relevant, provide the **complete, executable, production-grade code** (with error handling, timeouts/cancellation via AbortController, backpressure/streams, and graceful shutdown). Never use snippets, placeholders, or omit code.\n3. **Structured Architectural Breakdown (10/10):** Use clear markdown tables, pipeline diagrams, and side-by-side trade-off matrices.\n4. **Systems Trade-offs (10/10):** Honestly assess strengths, inherent failure modes/bottlenecks, and concrete production mitigations.\n5. **Production Operations Playbook (10/10):** Include Day-2 engineering guidance (kernel/runtime tuning, clustering, connection pooling, indexing, observability).\n\n---\n\n### 🌟 10/10 Response Blueprint:\n\n- **Concept Definition & Core Intuition (Natural Text, NO meta-headings):**\n  - Begin directly with **[Concept Name]** in bold with an authoritative 1–2 sentence definition.\n  - Follow immediately with a brief, vivid intuition or real-world systems mental model.\n\n- **1. Production-Grade Implementation / Schema Script (When code/schema is applicable):**\n  - Provide complete, drop-in, production-ready code (e.g., Full SQL DDL with constraints, or complete Node.js/Java/Go implementations with connection lifecycles and error boundaries).\n\n- **2. Under The Hood: Core Mechanics & Storage / Kernel Primitives:**\n  - Numbered pipeline steps detailing exact execution flow, memory allocations, data structures, and engine internals.\n\n- **3. Comparative Architecture Matrix:**\n  - Clean Markdown comparison table contrasting this technology against alternative architectures (Concurrency model, memory per connection, context switching, throughput).\n\n- **4. Primary Strengths & Inherent Bottlenecks:**\n  - #### 🚀 Strengths: Scalability, throughput, operational simplicity.\n  - #### ⚠️ Inherent Limitations & Mitigations: Bottlenecks (e.g. CPU blocking, GC pauses, lock contention) and their concrete engineering mitigations.\n\n- **5. Production Engineering Playbook:**\n  - Practical Day-2 production configuration: kernel parameters, process clustering, thread pool tuning, heap limits, and metrics.\n\n---\n\n### 🖋️ Tone & Formatting Rules:\n- **No Meta-Labels:** Never output labels like \"Opening Definition:\", \"30-Second Mental Model:\", or \"Section Header:\".\n- **Zero Fluff:** Dive immediately into technical reality.\n- **Section Dividers:** Separate major sections with horizontal rules (---).\n- **Strictly No Token Masks or Placeholders:** NEVER output placeholder masks, token markers, or fill-in-the-blank tokens such as ___TK0___, ___TK1___, ___TK___, [TODO], or <FILL>. Always write the actual, real programming language keywords (e.g. if, catch, try, return, throw, const), complete identifiers, and full production logic.";

const sanitizeChatResponse = (text) => {
    if (typeof text !== 'string') return text;

    return text
        // Case 1: } catch (err) {
        .replace(/}\s*___TK\d*___\s*(?=\()/g, '} catch ')
        // Case 2: async (req, res...
        .replace(/(=>|\s)\s*___TK\d*___\s*(?=\((?:req|request|ctx|event)?[\s:,])/gi, '$1 async ')
        // Case 3: if (...) condition
        .replace(/___TK\d*___\s*(?=\([^)]*(?:instanceof|===|!==|==|!=|!|\bhas\b|\bin\b|&&|\|\|))/g, 'if ')
        .replace(/___TK1___\s*(?=\()/g, 'if ')
        // General fallback: replace remaining ___TK\d*___ (error) { with catch (error) { if preceded by }
        .replace(/___TK\d*___\s*\(([^)]*(?:err|error)[^)]*)\)\s*\{/gi, 'catch ($1) {')
        // General fallback: replace ___TK\d*___ (...) { with if (...) {
        .replace(/___TK\d*___\s*(?=\([^)]*\)\s*\{)/g, 'if ')
        // Remove any other standalone ___TK\d*___
        .replace(/___TK\d*___/g, '');
};

const createStreamingSanitizer = (onChunk) => {
    let buffer = '';

    const flushClean = (text) => {
        if (!text) return;
        const cleaned = sanitizeChatResponse(text);
        if (cleaned) onChunk(cleaned);
    };

    return {
        write: (chunk) => {
            buffer += chunk;
            const partialMatch = buffer.match(/_{1,3}(?:T(?:K(?:\d*(?:_{0,3})?)?)?)?$/);
            if (partialMatch) {
                const safeLength = buffer.length - partialMatch[0].length;
                if (safeLength > 0) {
                    const toSend = buffer.slice(0, safeLength);
                    buffer = buffer.slice(safeLength);
                    flushClean(toSend);
                }
            } else {
                flushClean(buffer);
                buffer = '';
            }
        },
        end: () => {
            if (buffer.length > 0) {
                flushClean(buffer);
                buffer = '';
            }
        }
    };
};

const buildConversationRequest = ({message, history = []}) => {
    const cleanMessage = sanitizeChatResponse(message);
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
            parts: [{text: sanitizeChatResponse(content.trim())}],
        }));

    contents.push({
        role: 'user',
        parts: [{text: cleanMessage.trim()}],
    });

    const isKhmer = /[\u1780-\u17FF]/.test(cleanMessage);
    const dynamicLanguageDirective = isKhmer
        ? "\n\n### ⚡ CRITICAL LANGUAGE DIRECTIVE FOR THIS TURN:\n- The user's prompt is written in Khmer (ភាសាខ្មែរ).\n- You MUST respond ENTIRELY in fluent, natural, grammatically correct, and professional Khmer (ភាសាខ្មែរ).\n- Keep all programming code, syntax, terminal commands, function/variable names, and standard technical keywords in English."
        : "\n\n### ⚡ CRITICAL LANGUAGE DIRECTIVE FOR THIS TURN:\n- The user's prompt is in English. You MUST respond in English.";

    return {
        contents,
        config: {
            systemInstruction: `${CHAT_SYSTEM_INSTRUCTION}${dynamicLanguageDirective}`,
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

        const sanitizer = createStreamingSanitizer((chunkText) => {
            res.write(`data: ${JSON.stringify({ event: 'chunk', text: chunkText, done: false })}\n\n`);
        });

        const rawFullText = await skGeminiStream(contents, {
            config,
            onChunk: (chunkText) => {
                sanitizer.write(chunkText);
            },
        });
        sanitizer.end();

        const fullText = sanitizeChatResponse(rawFullText);

        // Final completion event
        res.write(`data: ${JSON.stringify({ event: 'done', text: '', done: true, fullText })}\n\n`);
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
