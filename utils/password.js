'use strict';

const bcrypt = require('bcrypt');

// Keep authentication work predictable across admin and developer accounts.
// Existing hashes remain valid; new hashes use this cost factor.
const BCRYPT_SALT_ROUNDS = 10;

const hashPassword = (plainPassword) => bcrypt.hash(plainPassword, BCRYPT_SALT_ROUNDS);

const verifyPassword = (plainPassword, hashedPassword) => {
    return bcrypt.compare(plainPassword, hashedPassword);
};

module.exports = {
    BCRYPT_SALT_ROUNDS,
    hashPassword,
    verifyPassword,
};
