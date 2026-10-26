'use strict';

const { AppError } = require('../utils/errors');
const { getCorrelationId } = require('../utils/asyncContext');

const DOMAIN_ERROR_MAP = {
  INVALID_CREDENTIALS: { statusCode: 401, title: 'INVALID_CREDENTIALS' },
  ACCOUNT_INACTIVE: { statusCode: 403, title: 'ACCOUNT_INACTIVE' },
  FORBIDDEN: { statusCode: 403, title: 'FORBIDDEN' },
  DEVELOPER_NOT_FOUND: { statusCode: 404, title: 'NOT_FOUND' },
  USER_NOT_FOUND: { statusCode: 404, title: 'NOT_FOUND' },
  APPROVAL_NOT_FOUND: { statusCode: 404, title: 'NOT_FOUND' },
  WORKFLOW_NOT_FOUND: { statusCode: 404, title: 'NOT_FOUND' },
  RUN_NOT_FOUND: { statusCode: 404, title: 'NOT_FOUND' },
  APPROVAL_ALREADY_RESOLVED: { statusCode: 409, title: 'CONFLICT' },
  INVALID_RUN_STATUS: { statusCode: 409, title: 'CONFLICT' },
  RUN_ALREADY_PLANNED: { statusCode: 409, title: 'CONFLICT' },
  VALIDATION_ERROR: { statusCode: 400, title: 'VALIDATION_ERROR' },
  INVALID_API_KEY_HASH: { statusCode: 400, title: 'INVALID_API_KEY_HASH' },
  INVALID_APPROVAL_STATUS: { statusCode: 400, title: 'BAD_REQUEST' },
  REJECTION_REASON_REQUIRED: { statusCode: 400, title: 'BAD_REQUEST' },
  INVALID_VERIFICATION_TOKEN: { statusCode: 400, title: 'INVALID_VERIFICATION_TOKEN' },
  EXPIRED_VERIFICATION_TOKEN: { statusCode: 400, title: 'EXPIRED_VERIFICATION_TOKEN' },
  VERIFICATION_TOKEN_REQUIRED: { statusCode: 400, title: 'VALIDATION_ERROR' },
  LLM_UNAVAILABLE: { statusCode: 503, title: 'SERVICE_UNAVAILABLE' },
  LLM_TIMEOUT: { statusCode: 504, title: 'GATEWAY_TIMEOUT' },
  LLM_ERROR: { statusCode: 503, title: 'SERVICE_UNAVAILABLE' },
  LLM_EMPTY_RESPONSE: { statusCode: 503, title: 'SERVICE_UNAVAILABLE' },
  PLANNER_ERROR: { statusCode: 502, title: 'BAD_GATEWAY' },
};

const DATABASE_UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_SEQUENCE_TIMEOUT',
]);

const DATABASE_UNAVAILABLE_MESSAGES = new Set([
  'Queue limit reached.',
  'No connections available.',
]);

function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  const correlationId = getCorrelationId() || req.correlationId || req.headers['x-correlation-id'] || null;

  let statusCode = 500;
  let title = 'INTERNAL_ERROR';
  let detail = 'An unexpected internal error occurred';
  let details = null;

  if (err instanceof AppError) {
    statusCode = err.statusCode;
    title = err.errorCode || err.name;
    detail = err.message;
    details = err.details;
  } else if (err.name === 'ValidationError' || err.isJoi) {
    statusCode = 422;
    title = 'VALIDATION_ERROR';
    detail = err.message || 'Validation failed';
    if (Array.isArray(err.details)) {
      details = err.details.map((d) => ({
        field: d.path ? d.path.join('.') : undefined,
        message: d.message ? d.message.replace(/"/g, '') : '',
        type: d.type,
      }));
    }
  } else if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    statusCode = 400;
    title = 'MALFORMED_JSON';
    detail = 'The request payload contains invalid JSON syntax';
  } else if (err.code && DOMAIN_ERROR_MAP[err.code]) {
    const mapped = DOMAIN_ERROR_MAP[err.code];
    statusCode = mapped.statusCode;
    title = mapped.title;
    detail = err.message;
  } else if (err.code === 'ER_DUP_ENTRY') {
    statusCode = 409;
    title = 'CONFLICT';
    detail = err.message?.includes('uq_users_email')
      ? 'A user with this email already exists'
      : 'A duplicate record was detected';
  } else if (
    DATABASE_UNAVAILABLE_CODES.has(err.code)
    || DATABASE_UNAVAILABLE_MESSAGES.has(err.message)
  ) {
    statusCode = 503;
    title = 'SERVICE_UNAVAILABLE';
    detail = 'The database is temporarily unavailable';
  } else if (err.message === 'Email already exists') {
    statusCode = 409;
    title = 'CONFLICT';
    detail = err.message;
  } else if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 600) {
    statusCode = err.statusCode;
    title = err.errorCode || (statusCode >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR');
    detail = err.message || 'Request rejected';
    details = err.details || null;
  }

  const problemDetails = {
    type: `https://api.kairo.com/errors/${title.toLowerCase().replace(/_/g, '-')}`,
    title,
    status: statusCode,
    detail,
    instance: req.originalUrl || req.url,
    correlationId,
    timestamp: new Date().toISOString(),
  };

  if (details) {
    problemDetails.invalidParams = details;
  }

  if (process.env.NODE_ENV !== 'production' && statusCode >= 500 && err.stack) {
    problemDetails.stack = err.stack;
  }

  if (statusCode >= 500) {
    console.error(`[ERROR][${correlationId || 'N/A'}] ${req.method} ${req.originalUrl}:`, err);
  }

  return res
    .status(statusCode)
    .contentType('application/problem+json')
    .json(problemDetails);
}

module.exports = errorHandler;
