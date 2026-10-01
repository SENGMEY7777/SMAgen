const crypto = require('crypto');
const developerModel = require('../../models/developers/developerModel');
const { sendVerificationEmail } = require('../../utils/mailService');
const { PASSWORD_REGEX } = require('../../validators/commonValidator');
const { hashPassword, verifyPassword } = require('../../utils/password');

const BCRYPT_SALT_ROUNDS = 10;

const hashPassword = async (plainPassword) => {
    return bcrypt.hash(plainPassword, BCRYPT_SALT_ROUNDS);
};

const verifyPassword = async (plainPassword, hashedPassword) => {
    return bcrypt.compare(plainPassword, hashedPassword);
};

const register = async (body) => {
    const checkUser = await developerModel.findUserByEmail(body.email);
    if (checkUser) {
        throw new Error('Email already exists');
    }

    const secureUserId = crypto.randomUUID();
    const rawPassword = body.password || '';

    if (!PASSWORD_REGEX.test(rawPassword)) {
        const error = new Error(
            'Password must be 8-128 characters and contain uppercase, lowercase, number, and one of @$!%*?&',
        );
        error.code = 'VALIDATION_ERROR';
        throw error;
    }

    const passwordHash = rawPassword ? await hashPassword(rawPassword) : '';
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await developerModel.register(body, passwordHash, secureUserId, verificationToken, verificationExpires);

    const userName = body.full_name || body.fullName || 'Developer';
    await sendVerificationEmail(body.email, verificationToken, userName);

    const now = new Date();
    return {
        id: secureUserId,
        email: body.email,
        full_name: body.full_name || body.fullName,
        phone_number: body.phone_number || body.phoneNumber || null,
        gender: body.gender || null,
        avatar_url: body.avatar_url || body.avatarUrl || null,
        role: 'DEVELOPER',
        is_active: 1,
        is_verified: 0,
        created_at: now,
        updated_at: now,
    };
};

const verifyEmail = async (token) => {
    if (!token || typeof token !== 'string') {
        throw new Error('Verification token is required');
    }

    const user = await developerModel.findUserByVerificationToken(token);
    if (!user) {
        throw new Error('Invalid verification token');
    }

    if (user.is_verified) {
        return { message: 'Email is already verified' };
    }

    if (user.verification_expires && new Date(user.verification_expires) < new Date()) {
        throw new Error('Verification token has expired');
    }

    await developerModel.verifyUserEmail(user.id);

    return {
        id: user.id,
        email: user.email,
        is_verified: 1,
    };
};

const resendVerificationEmail = async (email) => {
    if (!email || typeof email !== 'string') {
        throw new Error('Email is required');
    }

    const user = await developerModel.findUserByEmail(email.trim().toLowerCase());
    if (!user) {
        throw new Error('User with this email does not exist');
    }

    if (user.is_verified) {
        throw new Error('Email is already verified');
    }

    const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await developerModel.updateVerificationToken(user.id, verificationToken, verificationExpires);

    const userName = user.full_name || 'Developer';
    await sendVerificationEmail(user.email, verificationToken, userName);

    return {
        message: 'Verification link resent successfully',
    };
};

const logout = async (userId) => {
    const revoked = await developerModel.revokeUserTokens(userId);
    if (!revoked) {
        throw new Error('User not found');
    }
};

const createApiKey = async (userId) => {
    const apiKey = `sk_omni_${crypto.randomBytes(32).toString('hex')}`;
    const apiKeyHash = crypto
        .createHash('sha256')
        .update(apiKey)
        .digest('hex');

    const updated = await developerModel.updateApiKeyHash(userId, apiKeyHash);

    if (!updated) {
        const error = new Error('Developer account not found');
        error.code = 'DEVELOPER_NOT_FOUND';
        throw error;
    }

    return {
        apiKey,
    };
};

const jwt = require('jsonwebtoken');
const { getJwtConfig } = require('../../configs/jwt');

const login = async (email, password) => {
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const user = normalizedEmail ? await developerModel.findUserByEmail(normalizedEmail) : null;
    let isPasswordValid = false;

    if (user && user.password_hash && typeof password === 'string') {
        isPasswordValid = await verifyPassword(password, user.password_hash);
    }

    if (!isPasswordValid || user.role !== 'DEVELOPER') {
        const error = new Error('Invalid email or password');
        error.code = 'INVALID_CREDENTIALS';
        throw error;
    }

    if (Number(user.is_active) !== 1) {
        const error = new Error('Your account is inactive');
        error.code = 'ACCOUNT_INACTIVE';
        throw error;
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
            phone_number: user.phone_number,
            gender: user.gender,
            avatar_url: user.avatar_url,
            role: user.role,
            is_verified: user.is_verified,
            created_at: user.created_at,
            updated_at: user.updated_at,
        },
    };
};

module.exports = {
    register,
    login,
    verifyEmail,
    resendVerificationEmail,
    logout,
    createApiKey,
};
