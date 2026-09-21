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

module.exports = {
    login,
    logout,
};
