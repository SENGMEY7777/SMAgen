const sendResponse = require('../utils/responseHelper');

const requireRole = (...allowedRoles) => (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
        return sendResponse(res, 403, false, 'You do not have permission to access this resource', null, {
            code: 'FORBIDDEN',
        });
    }

    return next();
};

module.exports = requireRole;
