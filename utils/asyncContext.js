'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

const asyncLocalStorage = new AsyncLocalStorage();

function runWithContext(store, fn) {
  return asyncLocalStorage.run(store, fn);
}

function getContext() {
  return asyncLocalStorage.getStore();
}

function getCorrelationId() {
  const store = asyncLocalStorage.getStore();
  return store ? store.correlationId : null;
}

module.exports = {
  asyncLocalStorage,
  runWithContext,
  getContext,
  getCorrelationId,
};
