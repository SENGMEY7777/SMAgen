const jwt = require('jsonwebtoken');

const authModel = require('../models/admins/authModel');
const sendResponse = require('../utils/responseHelper');
const { getJwtConfig } = require('../configs/jwt');

const authenticate = async (req, res, next) => {
    const authorization = req.get('authorization') || '';
    const [scheme, token, ...extraParts] = authorization.split(' ');

    if (scheme !== 'Bearer' || !token || extraParts.length > 0) {
        return sendResponse(res, 401, false, 'Authentication required', null, {
            code: 'UNAUTHORIZED',
        });
    }

    try {
        const { secret, algorithm, issuer, audience } = getJwtConfig();
        const tokenUser = jwt.verify(token, secret, {
            algorithms: [algorithm],
            issuer,
            audience,
        });

        if (!tokenUser.sub || typeof tokenUser.sub !== 'string') {
            throw new Error('Token subject is missing');
        }

        const user = await authModel.findUserById(tokenUser.sub);

        if (
            !user ||
            Number(user.is_active) !== 1 ||
            user.deleted_at ||
            Number(user.token_version) !== Number(tokenUser.token_version)
        ) {
            throw new Error('Token has been revoked');
        }

        req.user = {
            ...tokenUser,
            id: user.id,
            role: user.role,
        };

        return next();
    } catch (error) {
        return sendResponse(res, 401, false, 'Invalid or expired token', null, {
            code: 'UNAUTHORIZED',
        });
    }
};

module.exports = authenticate;
