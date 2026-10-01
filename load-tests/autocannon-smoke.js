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
    const transportErrors = result.errors + result.timeouts;
    const non2xx = result.non2xx || 0;
    const failedResponses = transportErrors + non2xx;
    const errorRate = result.requests.total === 0
        ? 0
        : (failedResponses / result.requests.total) * 100;

    console.log(JSON.stringify({
        url,
        connections,
        duration,
        requests: result.requests,
        latency: result.latency,
        throughput: result.throughput,
        transportErrors,
        non2xx,
        failedResponses,
        errorRatePercent: Number(errorRate.toFixed(3)),
    }, null, 2));

    process.exitCode = failedResponses > 0 ? 1 : 0;
});
