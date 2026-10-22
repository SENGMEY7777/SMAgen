'use strict';

const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { validateEnvironment } = require('./env');

const config = validateEnvironment();

const getSslOptions = () => {
  if (!config.database.ssl) {
    return undefined;
  }

  const bundledCaPath = path.resolve(__dirname, '../certs/rds-ca.pem');
  const configuredCaPath = process.env.DB_SSL_CA;

  let caContent = null;
  if (configuredCaPath && fs.existsSync(configuredCaPath)) {
    caContent = fs.readFileSync(configuredCaPath, 'utf8');
  } else if (fs.existsSync(bundledCaPath)) {
    caContent = fs.readFileSync(bundledCaPath, 'utf8');
  }

  const sslOptions = {
    rejectUnauthorized: config.database.sslRejectUnauthorized,
  };

  if (caContent) {
    sslOptions.ca = caContent;
  } else if (config.nodeEnv !== 'production') {
    // In local development, avoid self-signed chain errors if no CA bundle is present
    sslOptions.rejectUnauthorized = false;
  }

  return sslOptions;
};

const clusterWorkers = Number(process.env.PM2_INSTANCES) || require('node:os').availableParallelism?.() || require('node:os').cpus().length || 1;
const perWorkerLimit = Math.max(2, Math.floor(config.database.pool.connectionLimit / clusterWorkers));
const perWorkerMaxIdle = Math.max(1, Math.floor(config.database.pool.maxIdle / clusterWorkers));

const pool = mysql.createPool({
    host: config.database.host,
    user: config.database.user,
    password: process.env.DB_PASSWORD || process.env.DB_PASS,
    database: config.database.name,
    port: config.database.port,
    waitForConnections: true,
    connectionLimit: perWorkerLimit,
    maxIdle: perWorkerMaxIdle,
    idleTimeout: config.database.pool.idleTimeout,
    queueLimit: config.database.pool.queueLimit,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    connectTimeout: config.database.connectTimeout,
    multipleStatements: false,
    ssl: getSslOptions(),
});

// mysql2 applies query timeouts per command, not as a pool option. Repositories
// use this value when issuing queries so an RDS stall cannot hold an HTTP
// request indefinitely.
pool.queryTimeout = config.database.queryTimeout;

module.exports = pool;
