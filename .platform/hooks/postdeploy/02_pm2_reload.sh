#!/usr/bin/env bash

echo "Reloading PM2 application after deployment..."
pm2 reload all || pm2 restart all || true
