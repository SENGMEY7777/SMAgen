const JWT_ALGORITHM = 'HS256';
const DEFAULT_ISSUER = 'ai-agent-api';
const DEFAULT_AUDIENCE = 'ai-agent-admin';
const DEFAULT_EXPIRES_IN = '15m';

const getJwtConfig = () => {
    const secret = process.env.JWT_SECRET;

    if (!secret || secret.length < 32) {
        const error = new Error('JWT_SECRET must be configured with at least 32 characters');
        error.code = 'JWT_CONFIG_ERROR';
        throw error;
    }

    return {
        secret,
        algorithm: JWT_ALGORITHM,
        issuer: process.env.JWT_ISSUER || DEFAULT_ISSUER,
        audience: process.env.JWT_AUDIENCE || DEFAULT_AUDIENCE,
        expiresIn: process.env.JWT_EXPIRES_IN || DEFAULT_EXPIRES_IN,
    };
};

module.exports = {
    getJwtConfig,
};
