const fs = require('fs');
const mysql = require('mysql2/promise');
const {validateEnvironment} = require('./env');

const config = validateEnvironment();

const getSslOptions = () => {
    if (!config.database.ssl) {
        return undefined;
    }

    const sslOptions = {
        rejectUnauthorized: config.database.sslRejectUnauthorized,
    };

    if (process.env.DB_SSL_CA) {
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
    connectionLimit: 10,
    queueLimit: 0,
    connectTimeout: 10000,
    multipleStatements: false,
    ssl: getSslOptions(),
});

module.exports = pool;
