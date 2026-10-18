'use strict';

const developerService = require('../../services/developers/developerService');
const sendResponse = require('../../utils/responseHelper');

const register = async (req, res, next) => {
    try {
        const result = await developerService.register(req.body);
        return sendResponse(res, 201, true, 'Registration successful', result);
    } catch (error) {
        return next(error);
    }
};

const verifyEmail = async (req, res, next) => {
    try {
        const query = req.validated?.query || req.query || {};
        const token = query.token || (req.body || {}).token;
        await developerService.verifyEmail(token);
        return sendResponse(res, 200, true, 'Email verified successfully', null);
    } catch (error) {
        return next(error);
    }
};

const resendVerification = async (req, res, next) => {
    try {
        const query = req.validated?.query || req.query || {};
        const email = (req.body || {}).email || query.email;
        await developerService.resendVerificationEmail(email);
        return sendResponse(res, 200, true, 'Verification link resent successfully');
    } catch (error) {
        return next(error);
    }
};

const logout = async (req, res, next) => {
    try {
        await developerService.logout(req.user.sub || req.user.id);
        return sendResponse(res, 200, true, 'Logout successfully!');
    } catch (error) {
        return next(error);
    }
};

const createApiKey = async (req, res, next) => {
    try {
        const result = await developerService.createApiKey(req.user.id);
        return sendResponse(
            res, 201, true,
            'API key created successfully. Store it securely; it will not be shown again.',
            result,
        );
    } catch (error) {
        return next(error);
    }
};

const login = async (req, res, next) => {
    try {
        const { email, password } = req.body || {};
        const result = await developerService.login(email, password);
        return sendResponse(res, 200, true, 'Login successful', result);
    } catch (error) {
        return next(error);
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
