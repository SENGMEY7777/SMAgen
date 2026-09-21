const router = require('express').Router();

const developerController = require('../../controllers/developers/developerContoller');
const validate = require('../../middleware/validate');
const { registerSchema } = require('../../validators/developer/authValidator');

router.post('/register', validate(registerSchema), developerController.register);

// Verification routes
router.get('/verify-email', developerController.verifyEmail);
router.get('/verify-link-email', developerController.verifyEmail);
router.post('/verify-email', developerController.verifyEmail);

// Resend verification routes
router.post('/resend-verification', developerController.resendVerification);
router.post('/resend-verification-link', developerController.resendVerification);
router.post('/resent-verification-link', developerController.resendVerification);

module.exports = router;
