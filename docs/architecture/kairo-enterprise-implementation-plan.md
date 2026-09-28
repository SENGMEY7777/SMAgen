# KAIRO Enterprise Implementation Plan

This is the implementation companion for [the KAIRO architecture review prompt](../templates/kairo-enterprise-architecture-review.md).

## Current repository baseline

- Runtime: CommonJS JavaScript; `package.json` currently declares no TypeScript build or test pipeline.
- HTTP layer: Express 5 with route-level validation and controller-local error responses.
- Persistence: `mysql2/promise` pool imported directly by model modules.
- Deployment: PM2 cluster mode is present; Elastic Beanstalk/Nginx deployment files need to be made authoritative.
- Scope note: `auth` and `developer` modules exist in this tree; a `billing` module is not currently present and needs its source/schema contract confirmed before migration.
- Verification: this change adds an `autocannon` smoke harness; endpoint, PM2, HTTP/2, and database-load evidence still require a production-like target.

Do not claim the target state is implemented until the TypeScript migration, repository seams, deployment smoke tests, and load-test evidence exist in CI.

## Target module boundary

```text
src/modules/<module>/
  <module>.routes.ts
  <module>.controller.ts
  <module>.service.ts
  <module>.repository.ts
  <module>.schemas.ts
  <module>.types.ts
src/shared/
  errors/app-error.ts
  errors/problem-details.middleware.ts
  http/async-handler.ts
  observability/request-context.ts
  persistence/unit-of-work.ts
```

## TypeScript application errors and RFC 7807

```ts
// src/shared/errors/app-error.ts
export type AppErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'DATABASE_ERROR'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  public readonly isOperational = true;

  constructor(
    public readonly statusCode: number,
    public readonly code: AppErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Request validation failed', details?: unknown) {
    super(400, 'VALIDATION_ERROR', message, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(404, 'NOT_FOUND', message);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource conflict') {
    super(409, 'CONFLICT', message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class DatabaseError extends AppError {
  constructor(message = 'Database operation failed', details?: unknown) {
    super(500, 'DATABASE_ERROR', message, details);
  }
}
```

```ts
// src/shared/errors/problem-details.middleware.ts
import type { ErrorRequestHandler, Request } from 'express';
import { randomUUID } from 'node:crypto';
import { AppError } from './app-error.js';
import { getRequestContext } from '../observability/request-context.js';

export const problemDetailsMiddleware: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) return next(error);

  const appError = error instanceof AppError
    ? error
    : new AppError(500, 'INTERNAL_ERROR', 'Internal server error');
  const requestId = getRequestContext()?.requestId ?? randomUUID();

  if (appError.statusCode >= 500) {
    const logger = (req as Request & {
      log?: { error?: (fields: Record<string, unknown>, message: string) => void };
    }).log;
    logger?.error?.({ err: error, requestId }, 'Unhandled request error');
  }

  return res.status(appError.statusCode).type('application/problem+json').json({
    type: `https://api.kairo.example/problems/${appError.code.toLowerCase()}`,
    title: appError.code,
    status: appError.statusCode,
    detail: appError.message,
    instance: req.originalUrl,
    requestId,
    ...(appError.details === undefined ? {} : { errors: appError.details }),
  });
};
```

## Declarative validation

```ts
// src/shared/http/validate.ts
import type { Request, RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { ValidationError } from '../errors/app-error.js';

type Source = 'body' | 'params' | 'query';

export const validate = <T>(schema: ZodType<T>, source: Source): RequestHandler => {
  return (req, _res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return next(new ValidationError('Request validation failed', result.error.flatten()));
    }

    (req as Request & { validated?: Record<string, unknown> }).validated ??= {};
    (req as Request & { validated: Record<string, unknown> }).validated[source] = result.data;
    return next();
  };
};
```

## AsyncLocalStorage request context

```ts
// src/shared/observability/request-context.ts
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

export type RequestContext = {
  requestId: string;
  traceId: string;
  startedAt: number;
};

const storage = new AsyncLocalStorage<RequestContext>();

export const requestContextMiddleware: RequestHandler = (req, res, next) => {
  const requestId = req.get('x-request-id')?.trim() || randomUUID();
  const traceId = req.get('x-trace-id')?.trim() || requestId;
  const context = { requestId, traceId, startedAt: Date.now() };

  res.setHeader('x-request-id', requestId);
  res.setHeader('x-trace-id', traceId);
  storage.run(context, next);
};

export const getRequestContext = (): RequestContext | undefined => storage.getStore();
```

## Unit of Work contract

```ts
// src/shared/persistence/unit-of-work.ts
export interface DbExecutor {
  query<T extends object = object>(sql: string, params?: readonly unknown[]): Promise<[T[], unknown]>;
}

export interface UnitOfWork {
  readonly db: DbExecutor;
  run<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T>;
}

export interface UserRepository {
  create(input: CreateUserInput, db: DbExecutor): Promise<User>;
}

// Services depend on UnitOfWork and repository interfaces only. They must not import
// mysql2, acquire/release pool connections, or issue SQL directly.
export type CreateUserInput = {
  id: string;
  email: string;
  passwordHash: string;
};

export type User = {
  id: string;
  email: string;
};
```

The production MySQL adapter should acquire one connection, `beginTransaction()`, call the service callback, commit on success, roll back on failure, and always release the connection in `finally`. Keep this adapter in `infrastructure/persistence`; never pass the pool into a service.

## Graceful shutdown and connection draining

```ts
// src/server.ts
const shutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  server.close(); // stop accepting new HTTP connections
  io.close();

  const forceExit = setTimeout(() => process.exit(1), 30_000);
  forceExit.unref();

  try {
    await scheduler.stop();
    await db.end();
    clearTimeout(forceExit);
    process.exit(0);
  } catch (error) {
    logger.fatal({ err: error, signal }, 'Graceful shutdown failed');
    process.exit(1);
  }
};

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
```

The actual KAIRO server must export its listener and shutdown function so deployment smoke tests can assert readiness and clean termination without importing a process that immediately listens.

## Elastic Beanstalk and PM2

```js
// ecosystem.config.cjs
module.exports = {
  apps: [{
    name: 'kairo-backend',
    script: './dist/server.js',
    exec_mode: 'cluster',
    instances: 'max',
    wait_ready: true,
    listen_timeout: 10000,
    kill_timeout: 30000,
    shutdown_with_message: true,
    max_memory_restart: '512M',
    exp_backoff_restart_delay: 100,
    merge_logs: true,
    time: true,
    env_production: {
      NODE_ENV: 'production',
    },
  }],
};
```

Use Elastic Beanstalk rolling or rolling-with-additional-batch deployments, a load-balancer health check that reaches a dependency-light readiness endpoint, and a deployment timeout greater than the 30-second application drain window. Keep database CA material in the platform secret/configuration mechanism or a protected instance path; never commit it or disable certificate verification in production.

## Nginx baseline

```nginx
# .platform/nginx/conf.d/00-kairo.conf
limit_req_zone $binary_remote_addr zone=kairo_api:10m rate=20r/s;

upstream kairo_node {
    keepalive 64;
    server 127.0.0.1:5000;
}

server {
    listen 80;
    server_name _;

    gzip on;
    gzip_comp_level 5;
    gzip_min_length 1024;
    gzip_types application/json application/javascript text/css text/plain;

    location /api/ {
        limit_req zone=kairo_api burst=40 nodelay;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Request-Id $request_id;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 5s;
        proxy_send_timeout 30s;
        proxy_read_timeout 60s;
        proxy_buffer_size 8k;
        proxy_buffers 8 16k;
        proxy_pass http://kairo_node;
    }
}
```

Terminate HTTP/2/TLS at the load balancer or the layer that owns the certificate. Do not add `listen ... http2` to a plain HTTP listener; protocol termination must match the actual certificate and ALPN configuration.

## Refactoring order

1. Introduce `AppError`, RFC 7807 middleware, `asyncHandler`, and request context behind compatibility adapters.
2. Convert `auth` first: controller -> service -> repository interfaces; preserve endpoint contracts and JWT behavior.
3. Convert `developer`, including registration/verification, then `billing` when its schema and transaction boundaries are confirmed.
4. Add the MySQL Unit of Work adapter and migrate every multi-write operation to it.
5. Split `createApp()` from `startServer()`, add readiness/liveness endpoints, and implement shutdown/draining.
6. Add the authoritative Elastic Beanstalk Nginx/PM2 configuration and CI checks.
7. Run load tests against a production-like environment and retain the results as deployment evidence.

Example smoke-test command after installing the test-only dependency in the test environment:

```bash
npm install --save-dev autocannon
LOAD_TEST_URL=https://staging-api.example.com/ npm run loadtest:smoke
```

## Acceptance checklist

- [ ] No service imports `mysql2`, an ORM model, or a connection pool.
- [ ] Every request has a response/request correlation ID and structured logs include it.
- [ ] Every expected domain failure maps to a typed error and RFC 7807 response.
- [ ] Production RDS TLS uses `rejectUnauthorized: true` and a trusted CA chain.
- [ ] SIGTERM stops new traffic, drains active HTTP/WebSocket work, stops schedulers, and closes the pool.
- [ ] PM2 readiness, memory restart, and shutdown settings are covered by a deployment smoke test.
- [ ] Nginx config is syntax-checked in CI and preserves WebSocket upgrade behavior where required.
- [ ] Load-test evidence includes throughput, p95/p99, 4xx/5xx rate, worker memory, and DB pool wait time.
