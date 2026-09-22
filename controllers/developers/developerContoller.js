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

const logout = async (req, res) => {
    try {
        await developerService.logout(req.user.sub || req.user.id);
        sendResponse(res, 200, true, 'Logout successfully!');
    } catch (error) {
        sendResponse(res, 500, false, error.message);
    }
};

const createApiKey = async (req, res) => {
    try {
        const result = await developerService.createApiKey(req.user.id);

        return sendResponse(
            res,
            201,
            true,
            'API key created successfully. Store it securely; it will not be shown again.',
            result,
        );
    } catch (error) {
        if (error.code === 'DEVELOPER_NOT_FOUND') {
            return sendResponse(res, 404, false, 'Developer account not found', null, {
                code: error.code,
            });
        }

        return sendResponse(res, 500, false, 'API key creation failed', null, {
            code: 'INTERNAL_ERROR',
        });
    }
};

const login = async (req, res) => {
    try {
        const { email, password, password_hash } = req.body || {};
        const result = await developerService.login(email, password || password_hash);
        sendResponse(res, 200, true, 'Login successful', result);
    } catch (error) {
        const isAuthError = error.code === 'INVALID_CREDENTIALS' || error.code === 'ACCOUNT_INACTIVE';
        sendResponse(res, isAuthError ? 401 : 500, false, error.message || 'Login failed');
    }
};

module.exports = {
    register,
    login,
    verifyEmail,
    resendVerification,
    logout,
    createApiKey,
};
