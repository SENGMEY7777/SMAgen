const repairMalformedJson = (value) => {
    const text = String(value || '');
    let result = '';
    let insideString = false;

    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];

        if (!insideString) {
            result += character;
            if (character === '"') {
                insideString = true;
            }
            continue;
        }

        if (character === '"') {
            result += character;
            insideString = false;
            continue;
        }

        const code = character.charCodeAt(0);
        if (code < 0x20) {
            if (character === '\n') result += '\\n';
            else if (character === '\r') result += '\\r';
            else if (character === '\t') result += '\\t';
            else result += '\\u' + code.toString(16).padStart(4, '0');
            continue;
        }

        if (character !== '\\') {
            result += character;
            continue;
        }

        const nextCharacter = text[index + 1];
        if (!nextCharacter) {
            result += '\\\\';
            continue;
        }

        // These are the only one-character escapes permitted by JSON.
        if ('"\\/bfnrt'.includes(nextCharacter)) {
            result += `\\${nextCharacter}`;
            index += 1;
            continue;
        }

        if (nextCharacter === 'u') {
            const unicodeDigits = text.slice(index + 2, index + 6);
            if (/^[0-9a-f]{4}$/i.test(unicodeDigits)) {
                result += `\\u${unicodeDigits}`;
                index += 5;
                continue;
            }
        }

        // Generated source often contains regexes (\\s, \\d, \\.) or
        // Windows paths (C:\\Users). Preserve the literal backslash by
        // escaping it for JSON instead of allowing JSON.parse to fail. Do not
        // consume the next character here: it may itself be a control
        // character that also needs escaping (for example, a raw newline
        // after an accidental backslash).
        result += '\\\\';
    }

    return result;
};

const parseJsonCandidate = (value) => {
    try {
        return JSON.parse(value);
    } catch (error) {
        try {
            return JSON.parse(repairMalformedJson(value));
        } catch (repairedError) {
            repairedError.code = 'LLM_INVALID_JSON';
            repairedError.message = `Gemini returned malformed JSON: ${repairedError.message}`;
            repairedError.cause = error;
            throw repairedError;
        }
    }
};

const parseJsonResponse = (rawText) => {
    const text = String(rawText || '')
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

    try {
        return parseJsonCandidate(text);
    } catch (error) {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');

        if (start >= 0 && end > start) {
            return parseJsonCandidate(text.slice(start, end + 1));
        }

        throw error;
    }
};

module.exports = {
    parseJsonResponse,
};
