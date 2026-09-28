'use strict';

const fs = require('fs');
const mysql = require('mysql2/promise');
const { validateEnvironment } = require('./env');

const config = validateEnvironment();

const getSslOptions = () => {
  if (!config.database.ssl) {
    return undefined;
  }

  const sslOptions = {
    rejectUnauthorized: config.database.sslRejectUnauthorized,
  };

  if (process.env.DB_SSL_CA && fs.existsSync(process.env.DB_SSL_CA)) {
    sslOptions.ca = fs.readFileSync(process.env.DB_SSL_CA, 'utf8');
  }

  return sslOptions;
};

const pool = mysql.createPool({
  host: config.database.host,
  user: config.database.user,
  password: process.env.DB_PASSWORD || process.env.DB_PASS,
  database: config.database.name,
  port: config.database.port,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_LIMIT || 10),
  maxIdle: Number(process.env.DB_POOL_MAX_IDLE || 10),
  idleTimeout: 60000,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  connectTimeout: 10000,
  multipleStatements: false,
  ssl: getSslOptions(),
});

module.exports = pool;
