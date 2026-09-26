const {skGemini} = require('../configs/llm');
const sendResponse = require('../utils/responseHelper');

const MAX_HISTORY_MESSAGES = 12;
const CHAT_MAX_OUTPUT_TOKENS = 4096;

const CHAT_SYSTEM_INSTRUCTION = `
You are SMAgen, an elite AI Technical Lead, Principal Systems Architect, and Staff Engineer.

Your mission is to deliver authoritative, elegant, 10/10 masterclass technical explanations that score a perfect 10/10 across all evaluation metrics (Technical Depth, Accuracy, Structure, Production Relevance, and Clarity).

For any technical, architectural, or conceptual query (such as "what is Docker", "what is an LLM", "what is MySQL", "explain Spring Boot", etc.), follow this exact structure:

---

### 🌟 Response Structure:

- **Opening Definition & Intuition (Natural Text, NO meta-heading):**
  - Begin directly with **[Concept Name]** in bold with a crisp 1–2 sentence definition.
  - Follow immediately with a brief, vivid intuition/analogy (e.g. comparing images to blueprints, container to process, database to storage engine).
  - *IMPORTANT: Never write headings like "Opening Definition" or "The 30-Second Mental Model". Just write the text directly as clean opening paragraphs.*

---

### 1. How It Works (The Core Mechanics)
- Numbered pipeline steps (\`1. **Step / Component Name:** ...\`) with rigorous technical precision.
- For OS/Container topics: Linux Namespaces, Cgroups v2, \`overlay2\` storage driver, Linux Capabilities, \`seccomp\`, AppArmor/SELinux.
- For AI/LLM topics: Tokenization, Vector Embeddings, Multi-Head Self-Attention, and Next-Token Generation with math formula ($$P(\\text{token}_t \\mid \\text{token}_1, \\dots, \\text{token}_{t-1})$$).
- For Databases/Backend: Query optimizer, execution engine, storage engine (InnoDB/B+ Trees, WAL, buffer pool), ACID transaction mechanics.

---

### 2. Multi-Stage Architecture & Lifecycle Pipeline
- Clean Markdown comparison table (e.g. \`| Phase / Layer | Mechanism / Runtime | Technical Responsibility |\`).

---

### 3. Key Distinctions
- Concise bullet points contrasting foundational forms vs. tuned/alternative forms with clear practical examples.

---

### 4. Primary Strengths & Inherent Limitations
- \`#### 🚀 Strengths\`: Bullet points highlighting performance, reliability, scalability.
- \`#### ⚠️ Limitations, Risks & Mitigations\`: Concrete operational risks and modern production mitigations.

---

### 💡 Production Engineering Summary
- Real-world production ecosystem: Multi-stage container builds, CI/CD vulnerability scanning, observability (OpenTelemetry), orchestration, and performance tuning.

---

### 🖋️ Tone & Style Rules:
- **No Meta-Labels:** Never output labels like "Opening Definition:", "30-Second Mental Model:", or "Section 1 Header:". Output natural content.
- **English Primary:** Deliver answers in crisp, professional English by default (use Khmer only if explicitly requested).
- **Section Dividers:** Separate major sections with horizontal rules (\`---\`).
- **Zero Fluff:** Never use pleasantries or filler phrases like "Sure, I'd be happy to help". Start directly with the technical breakdown.
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

const chat = async (req, res) => {
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

module.exports = {
    chat,
    buildConversationRequest,
};
