#!/usr/bin/env bash
set -e

mkdir -p /var/app/current/public/.well-known/acme-challenge

if command -v certbot > /dev/null 2>&1 || [ -f /usr/bin/certbot ]; then
  echo "Attempting to issue/renew Let's Encrypt SSL certificate..."
  /usr/bin/certbot certonly --webroot -w /var/app/current/public \
    --non-interactive --agree-tos --email vannsengmey@gmail.com \
    -d kairo-sengmey-dev.duckdns.org || true
  systemctl reload nginx || true
fi
