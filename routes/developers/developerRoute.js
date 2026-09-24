const router = require('express').Router();

const isLogin = require('../../middleware/authenticate');
const requireRole = require('../../middleware/authorize');
const {authAttemptLimiter} = require('../../middleware/rateLimiters');
const developerController = require('../../controllers/developers/developerContoller');
const validate = require('../../middleware/validate');
const { validateQuery } = require('../../middleware/validate');
const {
    registerSchema,
    loginSchema,
    verificationTokenSchema,
    resendVerificationSchema,
} = require('../../validators/developer/authValidator');
const {emptyBodySchema} = require('../../validators/commonValidator');

router.post('/register', authAttemptLimiter, validate(registerSchema), developerController.register);
router.post('/login', authAttemptLimiter, validate(loginSchema), developerController.login);
router.post('/api-keys', isLogin, requireRole('DEVELOPER'), validate(emptyBodySchema), developerController.createApiKey);

// Verification routes
router.get('/verify-email', validateQuery(verificationTokenSchema), developerController.verifyEmail);
router.get('/verify-link-email', validateQuery(verificationTokenSchema), developerController.verifyEmail);
router.post('/verify-email', validate(verificationTokenSchema), developerController.verifyEmail);

// Resend verification routes
router.post('/resend-verification', validate(resendVerificationSchema), developerController.resendVerification);
router.post('/resend-verification-link', validate(resendVerificationSchema), developerController.resendVerification);
router.get('/resend-verification', validateQuery(resendVerificationSchema), developerController.resendVerification);
router.get('/resend-verification-link', validateQuery(resendVerificationSchema), developerController.resendVerification);

// Logout routes
router.delete('/logout', isLogin, validate(emptyBodySchema), developerController.logout);

module.exports = router;
