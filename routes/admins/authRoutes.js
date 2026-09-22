const router = require('express').Router();
const rateLimit = require('express-rate-limit');

const authController = require('../../controllers/admins/authController');
const isLogin = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { loginSchema } = require('../../validators/admin/authValidator');

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
        success: false,
        message: 'Too many login attempts. Please try again later.',
        error: { code: 'RATE_LIMITED' },
    },
});

router.post('/login', loginLimiter, validate(loginSchema), authController.login);
router.post('/api-keys', isLogin, authController.createApiKey);
router.delete('/logout', isLogin, authController.logout);

module.exports = router;
