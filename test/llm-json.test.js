const test = require('node:test');
const assert = require('node:assert/strict');

const {parseJsonResponse} = require('../utils/jsonParser');
const {getModelCandidates} = require('../configs/llm');
const dbPool = require('../configs/db');

test.after(async () => {
    await dbPool.end();
});

test('repairs invalid backslashes in generated source and paths', () => {
    const malformed = String.raw`{"command":"node -e \"console.log(/\s+/)\"","path":"C:\Users\demo"}`;

    assert.deepEqual(parseJsonResponse(malformed), {
        command: 'node -e "console.log(/\\s+/)"',
        path: 'C:\\Users\\demo',
    });
});

test('repairs raw control characters inside generated strings', () => {
    const malformed = '{"content":"line one\nline two\tindented"}';

    assert.deepEqual(parseJsonResponse(malformed), {
        content: 'line one\nline two\tindented',
    });
});

test('preserves valid JSON escapes while repairing an invalid escape in the same string', () => {
    const malformed = String.raw`{"content":"quoted: \"hello\", regex: \d+, newline: \n, bad: \q"}`;

    assert.deepEqual(parseJsonResponse(malformed), {
        content: 'quoted: "hello", regex: \\d+, newline: \n, bad: \\q',
    });
});

test('does not select retired Gemini 1.5 or 2.5 models', () => {
    const candidates = getModelCandidates('models/gemini-2.5-flash-lite', 10);

    assert.equal(candidates.includes('gemini-2.5-flash-lite'), false);
    assert.equal(candidates.includes('gemini-1.5-flash'), false);
    assert.equal(candidates.includes('gemini-3.5-flash-lite'), true);
});
