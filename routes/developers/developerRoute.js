const router = require('express').Router();

const isLogin = require('../../middleware/authenticate');
const requireRole = require('../../middleware/authorize');
const developerController = require('../../controllers/developers/developerContoller');
const validate = require('../../middleware/validate');
const { registerSchema, loginSchema } = require('../../validators/developer/authValidator');

router.post('/register', validate(registerSchema), developerController.register);
router.post('/login', validate(loginSchema), developerController.login);
router.post('/api-keys', isLogin, requireRole('DEVELOPER'), developerController.createApiKey);

// Verification routes
router.get('/verify-email', developerController.verifyEmail);
router.get('/verify-link-email', developerController.verifyEmail);
router.post('/verify-email', developerController.verifyEmail);

// Resend verification routes
router.post('/resend-verification', developerController.resendVerification);
router.post('/resend-verification-link', developerController.resendVerification);

// Logout routes
router.delete('/logout', isLogin, developerController.logout);

module.exports = router;
