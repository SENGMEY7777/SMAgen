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

const pool = mysql.createPool({
  host: config.database.host,
  user: config.database.user,
  password: process.env.DB_PASSWORD || process.env.DB_PASS,
  database: config.database.name,
  port: config.database.port,
  waitForConnections: true,
  connectionLimit: 20,
  maxIdle: 10,
  idleTimeout: 60000,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  connectTimeout: 10000,
  multipleStatements: false,
  ssl: getSslOptions(),
});

module.exports = pool;
