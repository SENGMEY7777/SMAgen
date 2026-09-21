const pool = require('../../configs/db');

const findUserByEmail = async (email) => {
    const [rows] = await pool.query(
        `SELECT id, email, password_hash, full_name, gender, avatar_url, role,
                token_version, is_active, created_at, updated_at
         FROM users
         WHERE email = ?
           AND is_active = 1
           AND deleted_at IS NULL
         LIMIT 1`,
        [email],
    );
    return rows[0];
};


const findUserById = async (id) => {
    const [rows] = await pool.query(
        `SELECT id, email, full_name, role, token_version, is_active, deleted_at
         FROM users
         WHERE id = ?
         LIMIT 1`,
        [id],
    );
    return rows[0];
};

const login = async (email) => {
    return findUserByEmail(email);
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

const createUser = async ({ id, email, passwordHash, fullName, role = 'DEVELOPER' }) => {
    await pool.query(
        `INSERT INTO users (id, email, password_hash, full_name, role)
         VALUES (?, ?, ?, ?, ?)`,
        [id, email, passwordHash, fullName, role],
    );

    return {
        id,
        email,
        full_name: fullName,
        role,
    };
};

module.exports = {
    findUserByEmail,
    findUserById,
    login,
    revokeUserTokens,
    createUser,
};
