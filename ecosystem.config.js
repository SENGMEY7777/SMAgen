module.exports = {
  apps: [{
    name: 'kairo-backend',
    script: 'app.js',
    instances: 'max',
    exec_mode: 'cluster',
    max_memory_restart: '300M',
    env: {
      NODE_ENV: 'production',
      PORT: 5000
    }
  }]
};
