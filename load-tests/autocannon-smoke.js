#!/usr/bin/env node

const autocannon = require('autocannon');

const url = process.env.LOAD_TEST_URL || 'http://127.0.0.1:5000/';
const connections = Number.parseInt(process.env.LOAD_TEST_CONNECTIONS || '50', 10);
const duration = Number.parseInt(process.env.LOAD_TEST_DURATION_SECONDS || '30', 10);

const instance = autocannon({
    url,
    connections,
    duration,
    pipelining: 1,
    headers: {
        accept: 'application/json',
    },
});

autocannon.track(instance, {renderProgressBar: true});

instance.on('done', (result) => {
    const errors = result.errors + result.timeouts;
    const errorRate = result.requests.total === 0
        ? 0
        : (errors / result.requests.total) * 100;

    console.log(JSON.stringify({
        url,
        connections,
        duration,
        requests: result.requests,
        latency: result.latency,
        throughput: result.throughput,
        errors,
        errorRatePercent: Number(errorRate.toFixed(3)),
    }, null, 2));

    process.exitCode = errors > 0 ? 1 : 0;
});
