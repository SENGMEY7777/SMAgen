#!/usr/bin/env bash

CERT_PATH="/etc/letsencrypt/live/kairo-sengmey-dev.duckdns.org/fullchain.pem"
PUBLIC_DIR="/var/app/current/public"

mkdir -p "${PUBLIC_DIR}/.well-known/acme-challenge"
chmod -R 755 "${PUBLIC_DIR}"

if command -v certbot > /dev/null 2>&1 || [ -f /usr/bin/certbot ] || [ -f /usr/local/bin/certbot ]; then
  CERTBOT_BIN="$(command -v certbot || echo /usr/bin/certbot)"
  [ ! -x "$CERTBOT_BIN" ] && CERTBOT_BIN="/usr/local/bin/certbot"

  echo "Checking existing SSL certificate..."
  if [ -f "$CERT_PATH" ]; then
    ISSUER=$(openssl x509 -in "$CERT_PATH" -issuer -noout 2>/dev/null || echo "")
    if [[ "$ISSUER" != *"Let's Encrypt"* ]] && [[ "$ISSUER" != *"ISRG"* ]]; then
      echo "Removing dummy self-signed certificate before requesting Let's Encrypt cert..."
      rm -rf /etc/letsencrypt/live/kairo-sengmey-dev.duckdns.org \
             /etc/letsencrypt/archive/kairo-sengmey-dev.duckdns.org \
             /etc/letsencrypt/renewal/kairo-sengmey-dev.duckdns.org.conf 2>/dev/null || true
    fi
  fi

  echo "Attempting to issue/renew Let's Encrypt SSL certificate..."
  "$CERTBOT_BIN" certonly --webroot -w "$PUBLIC_DIR" \
    --non-interactive --agree-tos --email vannsengmey@gmail.com \
    -d kairo-sengmey-dev.duckdns.org || true

  # If certbot failed and left no cert, regenerate dummy so nginx stays alive
  if [ ! -f "$CERT_PATH" ]; then
    mkdir -p /etc/letsencrypt/live/kairo-sengmey-dev.duckdns.org
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
      -keyout /etc/letsencrypt/live/kairo-sengmey-dev.duckdns.org/privkey.pem \
      -out /etc/letsencrypt/live/kairo-sengmey-dev.duckdns.org/fullchain.pem \
      -subj "/CN=kairo-sengmey-dev.duckdns.org"
  fi

  systemctl reload nginx || true
fi
