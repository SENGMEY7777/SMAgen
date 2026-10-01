const crypto = require('crypto');
const authModel = require('../../models/admins/authModel');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { getJwtConfig } = require('../../configs/jwt');
const { PASSWORD_REGEX } = require('../../validators/commonValidator');

const BCRYPT_SALT_ROUNDS = 10;

const hashPassword = async (plainPassword) => {
    return bcrypt.hash(plainPassword, BCRYPT_SALT_ROUNDS);
};

const verifyPassword = async (plainPassword, hashedPassword) => {
    return bcrypt.compare(plainPassword, hashedPassword);
};

const invalidCredentialsError = () => {
    const error = new Error('Invalid email or password');
    error.code = 'INVALID_CREDENTIALS';
    return error;
};

const login = async (email, password) => {
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const user = normalizedEmail ? await authModel.login(normalizedEmail) : null;
    let isPasswordValid = false;

    if (user && typeof password === 'string') {
        isPasswordValid = await verifyPassword(password, user.password_hash);
    }

    if (!isPasswordValid || !['ADMIN', 'OPERATOR'].includes(user.role)) {
        throw invalidCredentialsError();
    }

    const { secret, algorithm, issuer, audience, expiresIn } = getJwtConfig();
    const token = jwt.sign(
        {
            sub: String(user.id),
            role: user.role,
            token_version: Number(user.token_version),
        },
        secret,
        {
            algorithm,
            expiresIn,
            issuer,
            audience,
        },
    );

    return {
        token,
        user: {
            id: user.id,
            email: user.email,
            full_name: user.full_name,
            gender: user.gender,
            avatar_url: user.avatar_url,
            role: user.role,
            created_at: user.created_at,
            updated_at: user.updated_at,
        },
    };
};

const register = async (body = {}) => {
    const { email, password, fullName, role = 'DEVELOPER' } = body;

    if (typeof email !== 'string' || typeof password !== 'string' || typeof fullName !== 'string') {
        const error = new Error('Email, password, and full name are required');
        error.code = 'VALIDATION_ERROR';
        throw error;
    }

    if (!PASSWORD_REGEX.test(password)) {
        const error = new Error(
            'Password must be 8-128 characters and contain uppercase, lowercase, number, and one of @$!%*?&',
        );
        error.code = 'VALIDATION_ERROR';
        throw error;
    }

    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const secureUserId = crypto.randomUUID();
    const passwordHash = await hashPassword(password);

    return authModel.createUser({
        id: secureUserId,
        email: normalizedEmail,
        passwordHash,
        fullName,
        role,
    });
};

const logout = async (userId) => {
    const revoked = await authModel.revokeUserTokens(userId);

    if (!revoked) {
        const error = new Error('User not found');
        error.code = 'USER_NOT_FOUND';
        throw error;
    }
};

const createApiKey = async (userId) => {
    const apiKey = `agy_live_${crypto.randomBytes(32).toString('hex')}`;
    const apiKeyHash = crypto
        .createHash('sha256')
        .update(apiKey)
        .digest('hex');

    const updated = await authModel.updateApiKeyHash(userId, apiKeyHash);

    if (!updated) {
        const error = new Error('User not found');
        error.code = 'USER_NOT_FOUND';
        throw error;
    }

    return {
        apiKey,
    };
};

module.exports = {
    login,
    register,
    logout,
    createApiKey,
};
