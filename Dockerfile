# ===================================================
# KAIRO Backend Production Dockerfile
# Node.js LTS with WebSocket & Sandboxing Support
# ===================================================
FROM node:20-alpine AS base

# Install system utilities needed for sandboxed commands
RUN apk add --no-cache bash git curl python3 make g++

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy application source code
COPY . .

# Ensure workspace directory exists and has write permissions
RUN mkdir -p workspaces && chmod 777 workspaces

# Default environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV WORKSPACE_ROOT=./workspaces

# Expose HTTP & WebSocket port
EXPOSE 3000

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/api/v1/auth/health || exit 1

# Start KAIRO server
CMD ["node", "app.js"]
