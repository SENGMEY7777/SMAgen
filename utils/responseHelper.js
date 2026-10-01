'use strict';

const { getCorrelationId } = require('./asyncContext');

/**
 * Standard API Response Envelope for KAIRO
 * Guarantees consistent JSON contracts across all microservices and controllers.
 *
 * @param {import('express').Response} res
 * @param {number} statusCode
 * @param {boolean} success
 * @param {string} message
 * @param {any} [data=null]
 * @param {any} [error=null]
 * @param {object} [extraMeta={}]
 */
const sendResponse = (res, statusCode, success, message, data = null, error = null, extraMeta = {}) => {
  const correlationId = getCorrelationId() || res.getHeader('x-correlation-id') || null;

  const body = {
    success: Boolean(success),
    message: message || (success ? 'Operation completed successfully' : 'Request failed'),
  };

  if (data !== null && data !== undefined) {
    body.data = data;
  }

  if (!success && error) {
    body.error = typeof error === 'string' ? { message: error, code: 'REQUEST_ERROR' } : error;
  }

  body.meta = {
    correlationId,
    timestamp: new Date().toISOString(),
    ...extraMeta,
  };

  return res.status(statusCode).json(body);
};

/**
 * Helper for 200/201 Success Responses
 */
sendResponse.success = (res, data = null, message = 'Success', statusCode = 200, meta = {}) => {
  return sendResponse(res, statusCode, true, message, data, null, meta);
};

/**
 * Helper for Error Responses
 */
sendResponse.error = (res, message = 'Error', statusCode = 500, error = null, meta = {}) => {
  return sendResponse(res, statusCode, false, message, null, error, meta);
};

module.exports = sendResponse;
