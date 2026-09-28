'use strict';

const { AppError } = require('../utils/errors');
const { getCorrelationId } = require('../utils/asyncContext');

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
  } else if (err.code === 'INVALID_CREDENTIALS' || err.message === 'Invalid email or password') {
    statusCode = 401;
    title = 'INVALID_CREDENTIALS';
    detail = err.message;
  } else if (err.code === 'ACCOUNT_INACTIVE') {
    statusCode = 403;
    title = 'ACCOUNT_INACTIVE';
    detail = err.message;
  } else if (err.code === 'DEVELOPER_NOT_FOUND' || err.message === 'User not found') {
    statusCode = 404;
    title = 'NOT_FOUND';
    detail = err.message;
  } else if (err.code === 'VALIDATION_ERROR' || err.code === 'INVALID_API_KEY_HASH') {
    statusCode = 400;
    title = err.code;
    detail = err.message;
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
