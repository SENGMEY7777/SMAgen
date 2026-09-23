const sendResponse = require('../utils/responseHelper');

const requireRole = (...allowedRoles) => (req, res, next) => {
    const userRole = String(req.user?.role || '').trim().toUpperCase();
    const normalizedAllowedRoles = allowedRoles.map((role) => String(role).trim().toUpperCase());

    if (!req.user || !normalizedAllowedRoles.includes(userRole)) {
        return sendResponse(res, 403, false, 'You do not have permission to access this resource', null, {
            code: 'FORBIDDEN',
        });
    }

    return next();
};

module.exports = requireRole;
