const crypto = require('crypto');
const bcrypt = require('bcrypt');
const developerModel = require('../../models/developers/developerModel');
const { sendVerificationEmail } = require('../../utils/mailService');

const register = async (body) => {
    const checkUser = await developerModel.findUserByEmail(body.email);
    if (checkUser) {
        throw new Error('Email already exists');
    }

    const secureUserId = crypto.randomUUID();
    const passwordHash = body.password ? await bcrypt.hash(body.password, 10) : '';
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

module.exports = {
    register,
    verifyEmail,
};
