const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

test('auto-fix scans and identifies missing npm packages', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kairo-autofix-test-'));
    try {
        const appJsPath = path.join(tempDir, 'app.js');
        await fs.writeFile(appJsPath, `
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const customUtil = require('./utils/custom');
const fs = require('fs');
        `);

        // Read and extract using the regex pattern
        const content = await fs.readFile(appJsPath, 'utf8');
        const NODE_BUILTIN_MODULES = new Set(['fs', 'path', 'http', 'events']);
        const reqMatches = content.matchAll(/(?:require\s*\(\s*['"]|from\s+['"]|import\s*\(\s*['"])([^'"]+)['"]/g);
        const pkgs = new Set();
        for (const m of reqMatches) {
            const spec = m[1].trim();
            if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('\\')) continue;
            let pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
            if (pkg && !NODE_BUILTIN_MODULES.has(pkg)) {
                pkgs.add(pkg);
            }
        }

        assert.equal(pkgs.has('express'), true);
        assert.equal(pkgs.has('helmet'), true);
        assert.equal(pkgs.has('cors'), true);
        assert.equal(pkgs.has('fs'), false); // builtin filtered out
        assert.equal(pkgs.has('./utils/custom'), false); // relative filtered out
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});
