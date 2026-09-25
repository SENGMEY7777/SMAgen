const router = require('express').Router();

const chatController = require('../controllers/chatController');
const isLogin = require('../middleware/authenticate');
const {chatLimiter} = require('../middleware/rateLimiters');
const validate = require('../middleware/validate');
const {chatSchema} = require('../validators/chatValidator');

router.post('/', isLogin, chatLimiter, validate(chatSchema), chatController.chat);

module.exports = router;
