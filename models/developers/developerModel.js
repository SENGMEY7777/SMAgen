'use strict';

const UserRepository = require('../../repositories/userRepository');
const userRepository = new UserRepository();

const findUserById = async (id) => {
  return userRepository.findById(id);
};

const findUserByEmail = async (email) => {
  return userRepository.findByEmail(email);
};

const register = async (body, passwordHash, id, verificationToken, verificationExpires) => {
  return userRepository.create({
    id,
    email: body.email,
    passwordHash,
    fullName: body.full_name || body.fullName,
    phoneNumber: body.phone_number || body.phoneNumber || null,
    gender: body.gender || null,
    avatarUrl: body.avatar_url || body.avatarUrl || null,
    role: 'DEVELOPER',
    verificationToken,
    verificationExpires,
  });
};

const findUserByVerificationToken = async (token) => {
  return userRepository.findByVerificationToken(token);
};

const verifyUserEmail = async (userId) => {
  return userRepository.verifyEmail(userId);
};

const updateVerificationToken = async (userId, token, expires) => {
  return userRepository.updateVerificationToken(userId, token, expires);
};

const revokeUserTokens = async (userId) => {
  return userRepository.revokeTokens(userId);
};

const updateApiKeyHash = async (userId, apiKeyHash) => {
  if (typeof apiKeyHash !== 'string' || !/^[a-f0-9]{64}$/i.test(apiKeyHash)) {
    const error = new Error('API key must be stored as a SHA-256 hash');
    error.code = 'INVALID_API_KEY_HASH';
    throw error;
  }
  return userRepository.updateApiKeyHash(userId, apiKeyHash);
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
