const developerService = require('../../services/developers/developerService');
const sendResponse = require('../../utils/responseHelper');

const register = async (req, res) => {
    try {
        let body = req.body;
        let result = await developerService.register(body);
        sendResponse(res, 201, true, 'Registration successful', result);
    } catch (error) {
        if (error.message === 'Email already exists') {
            return sendResponse(res, 400, false, error.message);
        }
        sendResponse(res, 500, false, error.message || 'Registration failed');
    }
};

const verifyEmail = async (req, res) => {
    try {
        const token = req.query.token || req.body.token;
        await developerService.verifyEmail(token);
        sendResponse(res, 200, true, 'Email verified successfully', null);
    } catch (error) {
        sendResponse(res, 400, false, error.message || 'Email verification failed');
    }
};

module.exports = {
    register,
    verifyEmail,
};