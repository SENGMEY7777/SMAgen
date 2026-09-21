const router = require('express').Router();

const isLogin = require('../../middleware/authenticate');
const developerController = require('../../controllers/developers/developerContoller');

router.post('/register', developerController.register);
router.get('/verify-email', developerController.verifyEmail);
router.post('/verify-email', developerController.verifyEmail);

module.exports = router;
