const jwt = require('jsonwebtoken');
const {Server} = require('socket.io');

const authModel = require('../models/admins/authModel');
const workflowModel = require('../models/workflow/workflowModel');
const {getJwtConfig} = require('../configs/jwt');
const {getCorsOrigins} = require('../configs/env');

const getSocketToken = (socket) => {
    const authorization = socket.handshake.headers.authorization || '';

    return socket.handshake.auth?.token
        || (authorization.startsWith('Bearer ') ? authorization.slice(7) : null);
};

const authenticateSocket = async (socket, next) => {
    const token = getSocketToken(socket);

    if (!token) {
        return next(new Error('Authentication required'));
    }

    try {
        const {secret, algorithm, issuer, audience} = getJwtConfig();
        const tokenUser = jwt.verify(token, secret, {
            algorithms: [algorithm],
            issuer,
            audience,
        });
        const user = await authModel.findUserById(tokenUser.sub);
        const tokenVersion = Number(tokenUser.token_version);
        const currentTokenVersion = Number(user?.token_version);

        if (
            !user
            || Number(user.is_active) !== 1
            || user.deleted_at
            || !Number.isInteger(tokenVersion)
            || tokenVersion < 1
            || currentTokenVersion !== tokenVersion
        ) {
            throw new Error('Invalid user session');
        }

        socket.user = {
            id: user.id,
            role: user.role,
        };

        return next();
    } catch (error) {
        return next(new Error('Invalid or expired token'));
    }
};

const canAccessRun = async (socket, runId) => {
    const role = String(socket.user.role || '').toUpperCase();
    const isPrivileged = ['ADMIN', 'OPERATOR'].includes(role);

    return workflowModel.getExecutionById(
        runId,
        isPrivileged ? null : socket.user.id,
    );
};

const initializeWebSocket = (server) => {
    const allowedOrigins = getCorsOrigins();

    const io = new Server(server, {
        cors: {
            origin: (origin, callback) => {
                const allowUnconfiguredDevelopmentOrigin = String(process.env.NODE_ENV || 'development').toLowerCase() !== 'production'
                    && allowedOrigins.length === 0;

                if (
                    !origin
                    || allowUnconfiguredDevelopmentOrigin
                    || allowedOrigins.includes('*')
                    || allowedOrigins.includes(origin)
                ) {
                    return callback(null, true);
                }

                return callback(new Error('CORS origin is not allowed'));
            },
            credentials: true,
        },
    });

    io.use(authenticateSocket);

    io.on('connection', (socket) => {
        socket.on('join_run', async (runId, acknowledge) => {
            try {
                const run = await canAccessRun(socket, runId);

                if (!run) {
                    return acknowledge?.({
                        success: false,
                        message: 'Workflow run not found',
                    });
                }

                await socket.join(`run_${runId}`);

                return acknowledge?.({
                    success: true,
                    runId,
                });
            } catch (error) {
                return acknowledge?.({
                    success: false,
                    message: 'Unable to join workflow run',
                });
            }
        });

        socket.on('leave_run', (runId) => {
            socket.leave(`run_${runId}`);
        });
    });

    return io;
};

module.exports = {
    initializeWebSocket,
};
