const developerService = require('../../services/developers/developerService');
const sendResponse = require('../../utils/responseHelper');

const register = async (req, res) => {
    try {
        let body = req.body;
        let result = await developerService.register(body);
        sendResponse(res, 201, true, 'Registration successful', result);
    } catch (error) {
        sendResponse(res, 500, false, error.message);
    }
};

const verifyEmail = async (req, res) => {
    try {
        const token = req.query.token || (req.body || {}).token;
        await developerService.verifyEmail(token);
        sendResponse(res, 200, true, 'Email verified successfully', null);
    } catch (error) {
        sendResponse(res, 400, false, error.message);
    }
};

const resendVerification = async (req, res) => {
    try {
        const email = (req.body || {}).email || req.query.email;
        await developerService.resendVerificationEmail(email);
        sendResponse(res, 200, true, 'Verification link resent successfully');
    } catch (error) {
        sendResponse(res, 400, false, error.message);
    }
};

module.exports = {
    register,
    verifyEmail,
    resendVerification,
};
