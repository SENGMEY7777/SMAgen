'use strict';

const authService = require('../../services/admins/authService');
const sendResponse = require('../../utils/responseHelper');

const login = async (req, res, next) => {
    try {
        const { email, password } = req.body;
        const result = await authService.login(email, password);
        return sendResponse(res, 200, true, 'Login successful', result);
    } catch (error) {
        return next(error);
    }
};

const register = async (req, res, next) => {
    try {
        const result = await authService.register(req.body);
        return sendResponse(res, 201, true, 'User registered successfully', result);
    } catch (error) {
        return next(error);
    }
};

const logout = async (req, res, next) => {
    try {
        await authService.logout(req.user.sub);
        return sendResponse(res, 200, true, 'Logout successful', null);
    } catch (error) {
        return next(error);
    }
};

const createApiKey = async (req, res, next) => {
    try {
        const result = await authService.createApiKey(req.user.id);
        return sendResponse(
            res, 201, true,
            'API key created successfully. Store it securely; it will not be shown again.',
            result,
        );
    } catch (error) {
        return next(error);
    }
};

module.exports = {
    login,
    register,
    logout,
    createApiKey,
};
