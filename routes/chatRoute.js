const router = require('express').Router();

const chatController = require('../controllers/chatController');
const isLogin = require('../middleware/authenticate');
const {chatLimiter} = require('../middleware/rateLimiters');
const validate = require('../middleware/validate');
const {chatSchema} = require('../validators/chatValidator');

// Standard Chat (supports ?stream=true query parameter)
router.post('/', isLogin, chatLimiter, validate(chatSchema), chatController.chat);

// Dedicated Live Streaming Route (Server-Sent Events)
router.post('/stream', isLogin, chatLimiter, validate(chatSchema), chatController.chatStream);

module.exports = router;
