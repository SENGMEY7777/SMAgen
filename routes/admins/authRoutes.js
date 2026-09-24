const router = require('express').Router();

const authController = require('../../controllers/admins/authController');
const isLogin = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const {authAttemptLimiter} = require('../../middleware/rateLimiters');
const { loginSchema } = require('../../validators/admin/authValidator');
const { emptyBodySchema } = require('../../validators/commonValidator');

router.post('/login', authAttemptLimiter, validate(loginSchema), authController.login);
router.post('/api-keys', isLogin, validate(emptyBodySchema), authController.createApiKey);
router.delete('/logout', isLogin, validate(emptyBodySchema), authController.logout);

module.exports = router;
