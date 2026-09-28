module.exports = {
  apps: [{
    name: 'kairo-backend',
    script: 'app.js',
    instances: 'max',
    exec_mode: 'cluster',
    wait_ready: true,
    listen_timeout: 10000,
    kill_timeout: 30000,
    shutdown_with_message: true,
    exp_backoff_restart_delay: 100,
    merge_logs: true,
    time: true,
    max_memory_restart: '300M',
    env: {
      NODE_ENV: 'production',
      PORT: 5000
    }
  }]
};
