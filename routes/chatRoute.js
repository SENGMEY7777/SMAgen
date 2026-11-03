const router = require('express').Router();
const { exec } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const chatController = require('../controllers/chatController');
const isLogin = require('../middleware/authenticate');
const {chatLimiter} = require('../middleware/rateLimiters');
const validate = require('../middleware/validate');
const {chatSchema} = require('../validators/chatValidator');

// Standard Chat (supports ?stream=true query parameter)
router.post('/', isLogin, chatLimiter, validate(chatSchema), chatController.chat);

// Dedicated Live Streaming Route (Server-Sent Events)
router.post('/stream', isLogin, chatLimiter, validate(chatSchema), chatController.chatStream);

// Native macOS directory picker without browser upload confirmation prompts
router.post('/choose-folder', (req, res) => {
    if (process.platform === 'darwin') {
        exec('osascript -e \'POSIX path of (choose folder with prompt "Select Project Folder")\'', { timeout: 120000 }, (err, stdout) => {
            if (err) {
                return res.json({ success: false, cancelled: true });
            }
            const fullPath = stdout.trim();
            if (!fullPath) {
                return res.json({ success: false, cancelled: true });
            }
            const folderName = path.basename(fullPath) || 'Local Project';
            return res.json({
                success: true,
                folder: {
                    name: folderName,
                    path: fullPath
                }
            });
        });
    } else {
        return res.json({ success: false, notSupported: true });
    }
});

// List local workspace folders on Desktop
router.get('/local-folders', (req, res) => {
    try {
        const desktopPath = path.join(os.homedir(), 'Desktop');
        const folders = [];
        if (fs.existsSync(desktopPath)) {
            const entries = fs.readdirSync(desktopPath, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory() && !entry.name.startsWith('.')) {
                    folders.push({
                        name: entry.name,
                        path: path.join(desktopPath, entry.name),
                        location: 'Desktop'
                    });
                }
            }
        }
        return res.json({ success: true, folders });
    } catch {
        return res.json({ success: false, folders: [] });
    }
});

module.exports = router;
