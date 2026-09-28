'use strict';

const BaseRepository = require('./baseRepository');

class UserRepository extends BaseRepository {
  constructor(unitOfWork = null) {
    super(unitOfWork);
  }

  async findById(id) {
    const [rows] = await this.query(
      `SELECT id, full_name, email, phone_number, gender, avatar_url, role,
              is_active, is_verified, created_at, updated_at, deleted_at
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [id]
    );
    return rows[0] || null;
  }

  async findByEmail(email) {
    const [rows] = await this.query(
      `SELECT id, email, password_hash, full_name, phone_number, gender, avatar_url, role,
              token_version, is_active, is_verified, created_at, updated_at
       FROM users
       WHERE email = ?
         AND deleted_at IS NULL
       LIMIT 1`,
      [email]
    );
    return rows[0] || null;
  }

  async findByVerificationToken(token) {
    const [rows] = await this.query(
      `SELECT id, email, is_verified, verification_expires
       FROM users
       WHERE verification_token = ?
         AND deleted_at IS NULL
       LIMIT 1`,
      [token]
    );
    return rows[0] || null;
  }

  async create(userData) {
    const {
      id,
      email,
      passwordHash,
      fullName,
      phoneNumber = null,
      gender = null,
      avatarUrl = null,
      role = 'DEVELOPER',
      verificationToken = null,
      verificationExpires = null,
    } = userData;

    const [result] = await this.query(
      `INSERT INTO users (
        id, email, password_hash, full_name, phone_number, gender,
        avatar_url, role, is_active, is_verified, verification_token, verification_expires
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
      [
        id,
        email,
        passwordHash,
        fullName,
        phoneNumber,
        gender,
        avatarUrl,
        role,
        verificationToken,
        verificationExpires,
      ]
    );

    return result;
  }

  async verifyEmail(userId) {
    const [result] = await this.query(
      `UPDATE users
       SET is_verified = 1,
           verification_token = NULL,
           verification_expires = NULL
       WHERE id = ?`,
      [userId]
    );
    return result.affectedRows > 0;
  }

  async updateVerificationToken(userId, token, expires) {
    const [result] = await this.query(
      `UPDATE users
       SET verification_token = ?,
           verification_expires = ?
       WHERE id = ?
         AND deleted_at IS NULL`,
      [token, expires, userId]
    );
    return result.affectedRows > 0;
  }

  async revokeTokens(userId) {
    const [result] = await this.query(
      `UPDATE users
       SET token_version = token_version + 1
       WHERE id = ?
         AND is_active = 1
         AND deleted_at IS NULL`,
      [userId]
    );
    return result.affectedRows > 0;
  }

  async updateApiKeyHash(userId, apiKeyHash) {
    const [result] = await this.query(
      `UPDATE users
       SET api_key_hash = ?
       WHERE id = ?
         AND role = 'DEVELOPER'
         AND is_active = 1
         AND deleted_at IS NULL`,
      [apiKeyHash, userId]
    );
    return result.affectedRows > 0;
  }
}

module.exports = UserRepository;
