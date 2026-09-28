'use strict';

const crypto = require('node:crypto');
const { runWithContext } = require('../utils/asyncContext');

function correlationMiddleware(req, res, next) {
  const incomingId = req.headers['x-correlation-id'] || req.headers['x-request-id'];
  const correlationId = (typeof incomingId === 'string' && incomingId.trim()) 
    ? incomingId.trim() 
    : crypto.randomUUID();

  res.setHeader('x-correlation-id', correlationId);
  req.correlationId = correlationId;

  const store = {
    correlationId,
    reqStartTime: process.hrtime.bigint(),
    path: req.originalUrl || req.url,
    method: req.method,
  };

  runWithContext(store, () => {
    next();
  });
}

module.exports = correlationMiddleware;
