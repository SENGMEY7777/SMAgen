const pool = require('../../configs/db');

const findUserById = async (id) => {
    const [rows] = await pool.query(
        `SELECT id, full_name, email, phone_number, gender, avatar_url, role, is_active, is_verified, created_at, updated_at, deleted_at
         FROM users
         WHERE id = ?
         LIMIT 1`,
        [id],
    );
    return rows[0];
};

const findUserByEmail = async (email) => {
    const [rows] = await pool.query(
        `SELECT id, email, password_hash, full_name, phone_number, gender, avatar_url, role,
                token_version, is_active, is_verified, created_at, updated_at
         FROM users
         WHERE email = ?
           AND deleted_at IS NULL
         LIMIT 1`,
        [email],
    );
    return rows[0];
};

const register = async (body, passwordHash, id, verificationToken, verificationExpires) => {
    let arr = [
        id,
        body.email,
        passwordHash,
        body.full_name || body.fullName,
        body.phone_number || body.phoneNumber || null,
        body.gender || null,
        body.avatar_url || body.avatarUrl || null,
        'DEVELOPER',
        verificationToken,
        verificationExpires,
    ];

    const [result] = await pool.query(
        `INSERT INTO users (id, email, password_hash, full_name, phone_number, gender, avatar_url, role, is_active, is_verified, verification_token, verification_expires)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
        arr,
    );

    return result;
};

const findUserByVerificationToken = async (token) => {
    const [rows] = await pool.query(
        `SELECT id, email, is_verified, verification_expires
         FROM users
         WHERE verification_token = ?
           AND deleted_at IS NULL
         LIMIT 1`,
        [token],
    );
    return rows[0];
};

const verifyUserEmail = async (userId) => {
    const [result] = await pool.query(
        `UPDATE users
         SET is_verified = 1,
             verification_token = NULL,
             verification_expires = NULL
         WHERE id = ?`,
        [userId],
    );
    return result.affectedRows > 0;
};

const updateVerificationToken = async (userId, token, expires) => {
    const [result] = await pool.query(
        `UPDATE users
         SET verification_token = ?,
             verification_expires = ?
         WHERE id = ?
           AND deleted_at IS NULL`,
        [token, expires, userId],
    );
    return result.affectedRows > 0;
};

const revokeUserTokens = async (userId) => {
    const [result] = await pool.query(
        `UPDATE users
         SET token_version = token_version + 1
         WHERE id = ?
           AND is_active = 1
           AND deleted_at IS NULL`,
        [userId],
    );

    return result.affectedRows > 0;
};

const updateApiKeyHash = async (userId, apiKeyHash) => {
    const [result] = await pool.query(
        `UPDATE users
         SET api_key_hash = ?
         WHERE id = ?
           AND role = 'DEVELOPER'
           AND is_active = 1
           AND deleted_at IS NULL`,
        [apiKeyHash, userId],
    );

    return result.affectedRows > 0;
};

module.exports = {
    findUserById,
    findUserByEmail,
    findUserByVerificationToken,
    verifyUserEmail,
    updateVerificationToken,
    revokeUserTokens,
    updateApiKeyHash,
    register,
};
