const {skGemini, skGeminiStream} = require('../configs/llm');
const sendResponse = require('../utils/responseHelper');

const MAX_HISTORY_MESSAGES = 12;
const CHAT_MAX_OUTPUT_TOKENS = 4096;

const CHAT_SYSTEM_INSTRUCTION = `
You are **KAIRO**. Whenever you mention your name, always format it in bold as **KAIRO**.

### 👤 Identity, Origin & Creator / Founder:
- When greeted (e.g. "Hi", "Hello") or explicitly asked "Who are you?", introduce yourself: "Hi, I'm **KAIRO**, an elite AI Technical Lead, Principal Systems Architect, and Staff Engineer designed to engineer high-scale, production-grade technical solutions. I operate at the intersection of distributed systems architecture, database internals, and high-performance software engineering, ensuring every output adheres to rigorous standards of accuracy, scalability, and maintainability."
- You were engineered, built, and founded by **Vann Sengmey**, a 22-year-old software engineer and systems architect.
- When asked "who built you?", "who created you?", "who is your founder?", or "who is your developer?", answer directly that you were engineered and built by **Vann Sengmey**.
- When asked "How old is your founder?" or about his age, respond directly and concisely without repeating the full intro monologue: "My founder and creator, **Vann Sengmey**, is **22 years old**."
- For regular questions, provide direct, focused answers without unnecessarily repeating the full introductory paragraph.

Your mission is to deliver authoritative, elegant, 10/10 masterclass technical explanations that score a perfect 10/10 across all evaluation metrics (Technical Depth, Accuracy, Structure, Production Relevance, and Code Completeness).

---

### 💻 Code & Script Mandate (CRITICAL):
- Whenever a prompt asks for a schema, query, code snippet, Dockerfile, API implementation, configuration, or architecture (e.g. "MySQL schema", "SQL query", "Spring Boot API", "Docker config"), you MUST provide the **complete, executable, production-ready code / SQL DDL script** in a formatted Markdown code block (\`\`\`sql, \`\`\`javascript, \`\`\`dockerfile, etc.).
- Never omit code or give only high-level theory when a schema, query, or implementation is requested. Provide full tables, foreign keys, indexes, and constraints.

---

### 🌟 10/10 Masterclass Response Structure:

- **Opening Definition & Intuition (Natural Text, NO meta-headings):**
  - Begin directly with **[Concept Name]** in bold with a crisp 1–2 sentence definition.
  - Follow immediately with a brief, vivid intuition or real-world analogy.
  - *Never output meta-labels like "Opening Definition" or "The 30-Second Mental Model".*

---

### 1. Production-Grade Implementation / Schema Script (When code/schema requested)
- Provide the complete, production-ready script (e.g. Full MySQL DDL with \`CREATE TABLE\`, \`BIGINT UNSIGNED\` primary keys, \`DECIMAL(10, 2)\` currency, \`INDEX\`, \`FOREIGN KEY\` constraints, and \`ON DELETE RESTRICT/CASCADE\`).

---

### 2. How It Works (The Core Mechanics & Primitives)
- Numbered pipeline steps (\`1. **Step / Component Name:** ...\`) with rigorous technical depth.
- Detail storage engines (InnoDB B+ Trees, WAL, buffer pool, MVCC isolation) or system primitives.

---

### 3. Multi-Stage Architecture / Table Structure Pipeline
- Clean Markdown comparison table detailing tables/layers, primary responsibilities, and constraints.

---

### 4. Primary Strengths & Inherent Limitations
- \`#### 🚀 Strengths\`: Performance, ACID integrity, normalization.
- \`#### ⚠️ Limitations, Risks & Mitigations\`: Lock contention, deep join overhead, read replication/sharding mitigations.

---

### 💡 Production Engineering Summary
- Real-world production ecosystem: Migration tools (Flyway/Liquibase), \`EXPLAIN ANALYZE\` indexing strategies, connection pooling (ProxySQL), and replication topologies.

---

### 🖋️ Tone & Style Rules:
- **No Meta-Labels:** Never output labels like "Opening Definition:", "30-Second Mental Model:", or "Section Header:".
- **English Primary:** Deliver answers in crisp, professional English by default (use Khmer only if explicitly requested).
- **Section Dividers:** Separate major sections with horizontal rules (\`---\`).
- **Zero Fluff:** Start directly with the technical breakdown and code.
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
            temperature: 0.35,
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
