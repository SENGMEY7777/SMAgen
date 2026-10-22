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
        const result = await developerService.verifyEmail(token);

        if (req.method === 'GET' && req.headers.accept?.includes('text/html')) {
            return res.status(200).send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Email Verified - KAIRO</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #0a0e17; color: #e2e8f0; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: #131b2e; border: 1px solid rgba(255,255,255,0.08); padding: 40px; border-radius: 16px; text-align: center; max-width: 440px; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
    .icon { width: 64px; height: 64px; background: rgba(16,185,129,0.15); border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; color: #10b981; font-size: 32px; }
    h1 { font-size: 22px; margin: 0 0 10px; color: #fff; }
    p { color: #94a3b8; font-size: 14px; margin: 0 0 24px; line-height: 1.6; }
    .btn { display: inline-block; background: #2563eb; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 600; font-size: 14px; transition: background 0.2s; }
    .btn:hover { background: #1d4ed8; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✓</div>
    <h1>Email Verified Successfully</h1>
    <p>Your KAIRO developer account has been confirmed. You can now log in to access the platform.</p>
    <a href="/login" class="btn">Proceed to Login</a>
  </div>
</body>
</html>
            `);
        }

        return sendResponse(res, 200, true, 'Email verified successfully', result);
    } catch (error) {
        if (req.method === 'GET' && req.headers.accept?.includes('text/html')) {
            return res.status(error.statusCode || 400).send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Verification Failed - KAIRO</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #0a0e17; color: #e2e8f0; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: #131b2e; border: 1px solid rgba(255,255,255,0.08); padding: 40px; border-radius: 16px; text-align: center; max-width: 440px; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
    .icon { width: 64px; height: 64px; background: rgba(239,68,68,0.15); border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; color: #ef4444; font-size: 32px; }
    h1 { font-size: 22px; margin: 0 0 10px; color: #fff; }
    p { color: #94a3b8; font-size: 14px; margin: 0 0 24px; line-height: 1.6; }
    .btn { display: inline-block; background: #334155; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 600; font-size: 14px; transition: background 0.2s; }
    .btn:hover { background: #475569; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✕</div>
    <h1>Verification Failed</h1>
    <p>${error.message || 'The verification link is invalid or has expired.'}</p>
    <a href="/login" class="btn">Return to Login</a>
  </div>
</body>
</html>
            `);
        }
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

        if (!email || !password) {
            const error = new Error('Email and password are required');
            error.code = 'VALIDATION_ERROR';
            return next(error);
        }

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
