const authService = require('../../services/admins/authService');
const sendResponse = require('../../utils/responseHelper');

const login = async (req, res) => {
    try {
        let { email, password, password_hash } = req.body;
        let result = await authService.login(email, password || password_hash);
        sendResponse(res, 200, true, 'Login successful', result);
    } catch (error) {
        const isInvalidCredentials = error.code === 'INVALID_CREDENTIALS';

        if (isInvalidCredentials) {
            return sendResponse(res, 401, false, 'Invalid email or password', null);
        }

        sendResponse(
            res,
            500,
            false,
            'Login failed',
            null,
            { code: 'INTERNAL_ERROR' },
        );
    }
};


const logout = async (req, res) => {
    try {
        await authService.logout(req.user.sub);
        sendResponse(res, 200, true, 'Logout successful', null);
    } catch (error) {
        sendResponse(res, 500, false, 'Logout failed', null, {
            code: 'INTERNAL_ERROR',
        });
    }
};

const createApiKey = async (req, res) => {
    try {
        const result = await authService.createApiKey(req.user.id);

        return sendResponse(
            res,
            201,
            true,
            'API key created successfully. Store it securely; it will not be shown again.',
            result,
        );
    } catch (error) {
        if (error.code === 'USER_NOT_FOUND') {
            return sendResponse(res, 404, false, 'User not found', null, {
                code: error.code,
            });
        }

        return sendResponse(res, 500, false, 'API key creation failed', null, {
            code: 'INTERNAL_ERROR',
        });
    }
};

module.exports = {
    login,
    logout,
    createApiKey,
};
