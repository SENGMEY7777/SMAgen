# =========================================================================
# KAIRO Backend Production Multi-Stage Dockerfile (Node.js 22 LTS)
# =========================================================================

# -------------------------------------------------------------------------
# Stage 1: Build & Dependency Isolation
# -------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Install native dependencies required for C++ addons (e.g. bcrypt)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

# Leverage Docker cache layer for package resolution
COPY package*.json ./

# Deterministic dependency install
RUN npm ci

# Copy project source
COPY . .

# Prune development dependencies to produce minimal production footprint
RUN npm prune --omit=dev --ignore-scripts

# -------------------------------------------------------------------------
# Stage 2: Hardened Production Runtime
# -------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=5000

# Install dumb-init to act as PID 1 (zombie process reaping & signal forwarding)
RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
  && rm -rf /var/lib/apt/lists/*

# Enforce Principle of Least Privilege: Create dedicated unprivileged user
RUN groupadd --gid 10001 appgroup && \
    useradd --uid 10001 --gid appgroup --shell /bin/false --no-create-home appuser

# Pre-create required writable directories with non-root ownership
RUN mkdir -p /app/workspaces /app/certs && \
    chown -R appuser:appgroup /app

# Copy production artifacts with explicit non-root ownership
COPY --chown=appuser:appgroup --from=builder /app/package.json ./package.json
COPY --chown=appuser:appgroup --from=builder /app/node_modules ./node_modules
COPY --chown=appuser:appgroup --from=builder /app/configs ./configs
COPY --chown=appuser:appgroup --from=builder /app/controllers ./controllers
COPY --chown=appuser:appgroup --from=builder /app/core ./core
COPY --chown=appuser:appgroup --from=builder /app/helpers ./helpers
COPY --chown=appuser:appgroup --from=builder /app/middleware ./middleware
COPY --chown=appuser:appgroup --from=builder /app/models ./models
COPY --chown=appuser:appgroup --from=builder /app/public ./public
COPY --chown=appuser:appgroup --from=builder /app/repositories ./repositories
COPY --chown=appuser:appgroup --from=builder /app/routes ./routes
COPY --chown=appuser:appgroup --from=builder /app/services ./services
COPY --chown=appuser:appgroup --from=builder /app/tools ./tools
COPY --chown=appuser:appgroup --from=builder /app/utils ./utils
COPY --chown=appuser:appgroup --from=builder /app/validators ./validators
COPY --chown=appuser:appgroup --from=builder /app/certs ./certs
COPY --chown=appuser:appgroup --from=builder /app/app.js ./app.js

# Switch to non-root execution context
USER appuser

# Expose HTTP & WebSocket port
EXPOSE 5000

# Native Node.js health check (no curl dependency needed)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 5000) + '/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Intercept and propagate signals to Node.js cleanly
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "app.js"]
