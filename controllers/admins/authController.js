const authService = require('../../services/admins/authService');
const sendResponse = require('../../utils/responseHelper');

const login = async (req, res) => {
    try {
        let { email, password } = req.body;
        let result = await authService.login(email, password);
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

const register = async (req, res) => {
    try {
        let result = await authService.register(req.body);
        sendResponse(res, 201, true, 'Registration successful', result);
    } catch (error) {
        const isDuplicateEmail = error.code === 'ER_DUP_ENTRY';
        const isValidationError = error.code === 'VALIDATION_ERROR';

        sendResponse(
            res,
            isDuplicateEmail ? 409 : isValidationError ? 400 : 500,
            false,
            isDuplicateEmail
                ? 'Email is already registered'
                : isValidationError
                    ? error.message
                    : 'Registration failed',
            null,
            { code: isDuplicateEmail ? 'EMAIL_EXISTS' : isValidationError ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR' },
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
    register,
    logout,
};
