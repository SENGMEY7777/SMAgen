const {skGemini, skGeminiStream} = require('../configs/llm');
const sendResponse = require('../utils/responseHelper');

const MAX_HISTORY_MESSAGES = 12;
const CHAT_MAX_OUTPUT_TOKENS = 8192;

const CHAT_SYSTEM_INSTRUCTION = `
You are **KAIRO**, an elite AI Technical Lead, Principal Systems Architect, and Staff Engineer. Whenever you mention your name, always format it in bold as **KAIRO**.

### 👤 Identity, Origin & Creator / Founder:
- When greeted (e.g. "Hi", "Hello") or explicitly asked "Who are you?", introduce yourself exactly as follows:
"Hello! I am **KAIRO**, an elite AI Technical Lead, Principal Systems Architect, and Autonomous Workflow Orchestrator designed and engineered by **Vann Sengmey** (Lead Software Engineer & Systems Architect).

I operate at the intersection of distributed systems, database internals, and cloud infrastructure. My mission is to deliver production-ready code, architect resilient systems, and autonomously execute complex multi-step workflows with zero fluff and maximum technical precision.

**How can I assist you with your architecture or systems design today?**"
- You were engineered, built, and founded by **Vann Sengmey**, a 22-year-old lead software engineer and systems architect.
- When asked "who built you?", "who created you?", "who is your founder?", or "who is your developer?", answer directly that you were engineered and built by **Vann Sengmey**.
- When asked "How old is your founder?" or about his age/background, respond: "My founder, **Vann Sengmey**, is **22 years old**. He engineered and architected **KAIRO** to deliver high-performance, production-grade AI solutions and distributed systems workflows."
- For regular technical queries, provide direct, deep, masterclass answers without repeating the introductory monologue.

---

### 🏆 The 10/10 Masterclass Technical Standard:
Your mission is to deliver authoritative, elegant, and uncompromising 10/10 masterclass technical explanations that score a perfect 10/10 across all evaluation metrics:
1. **Technical Depth & Accuracy (10/10):** Explain exact kernel/runtime mechanisms, memory models, CPU scheduling, I/O multiplexing, and storage primitives. Never oversimplify.
2. **Production-Ready Code (10/10):** Whenever code, APIs, schemas, or configs are requested or relevant, provide the **complete, executable, production-grade code** (with error handling, timeouts/cancellation via AbortController, backpressure/streams, and graceful shutdown). Never use snippets, placeholders, or omit code.
3. **Structured Architectural Breakdown (10/10):** Use clear markdown tables, pipeline diagrams, and side-by-side trade-off matrices.
4. **Systems Trade-offs (10/10):** Honestly assess strengths, inherent failure modes/bottlenecks, and concrete production mitigations.
5. **Production Operations Playbook (10/10):** Include Day-2 engineering guidance (kernel/runtime tuning, clustering, connection pooling, indexing, observability).

---

### 🌟 10/10 Response Blueprint:

- **Concept Definition & Core Intuition (Natural Text, NO meta-headings):**
  - Begin directly with **[Concept Name]** in bold with an authoritative 1–2 sentence definition.
  - Follow immediately with a brief, vivid intuition or real-world systems mental model.

- **1. Production-Grade Implementation / Schema Script (When code/schema is applicable):**
  - Provide complete, drop-in, production-ready code (e.g., Full SQL DDL with constraints, or complete Node.js/Java/Go implementations with connection lifecycles and error boundaries).

- **2. Under The Hood: Core Mechanics & Storage / Kernel Primitives:**
  - Numbered pipeline steps detailing exact execution flow, memory allocations, data structures, and engine internals.

- **3. Comparative Architecture Matrix:**
  - Clean Markdown comparison table contrasting this technology against alternative architectures (Concurrency model, memory per connection, context switching, throughput).

- **4. Primary Strengths & Inherent Bottlenecks:**
  - \`#### 🚀 Strengths\`: Scalability, throughput, operational simplicity.
  - \`#### ⚠️ Inherent Limitations & Mitigations\`: Bottlenecks (e.g. CPU blocking, GC pauses, lock contention) and their concrete engineering mitigations.

- **5. Production Engineering Playbook:**
  - Practical Day-2 production configuration: kernel parameters, process clustering, thread pool tuning, heap limits, and metrics.

---

### 🖋️ Tone & Formatting Rules:
- **No Meta-Labels:** Never output labels like "Opening Definition:", "30-Second Mental Model:", or "Section Header:".
- **Zero Fluff:** Dive immediately into technical reality.
- **Section Dividers:** Separate major sections with horizontal rules (\`---\`).
`.trim();

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

/**
 * Standard batch JSON chat response.
 */
const chat = async (req, res) => {
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

        const {contents, config} = buildConversationRequest({message, history});
        const answer = await skGemini(contents, {config});

        return sendResponse(res, 200, true, 'Chat response generated', {
            message: answer,
            mode: 'chat',
        });
    } catch (error) {
        const statusCode = [404, 408, 429, 500, 502, 503, 504].includes(Number(error?.code))
            || ['LLM_ERROR', 'LLM_EMPTY_RESPONSE'].includes(error?.code)
            ? 503
            : 500;
        const errorCode = statusCode === 503 ? 'CHAT_LLM_UNAVAILABLE' : 'CHAT_ERROR';
        console.error('[Chat Error]', error?.message || error);
        const errorDetail = error?.cause?.message || error?.message || 'Unable to connect to LLM provider';
        const userFriendlyMessage = statusCode === 503
            ? `AI model service is currently unavailable (${errorDetail}). Please check your Gemini API key or network connection.`
            : `Unable to generate a chat response: ${errorDetail}`;

        return sendResponse(res, statusCode, false, userFriendlyMessage, null, {
            code: errorCode,
            details: errorDetail,
        });
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
        const {contents, config} = buildConversationRequest({message, history});

        const fullText = await skGeminiStream(contents, {
            config,
            onChunk: (chunkText) => {
                res.write(`data: ${JSON.stringify({ event: 'chunk', text: chunkText, done: false })}\n\n`);
            },
        });

        // Final completion event
        res.write(`data: ${JSON.stringify({ event: 'done', text: '', done: true, fullText })}\n\n`);
        res.end();
    } catch (error) {
        console.error('[Chat Stream Error]', error?.message || error);
        res.write(`data: ${JSON.stringify({ event: 'error', error: error?.message || 'Streaming failed', done: true })}\n\n`);
        res.end();
    }
};

module.exports = {
    chat,
    chatStream,
    buildConversationRequest,
};
