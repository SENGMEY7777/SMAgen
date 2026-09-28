# KAIRO Enterprise Architecture Review Prompt

Use this prompt when evaluating a KAIRO microservice or proposing a production architecture change.

```markdown
Act as a Principal Node.js Enterprise Architect and Senior Cloud Infrastructure Engineer. Review and elevate the backend architecture of KAIRO (a high-performance developer platform deployed on AWS Elastic Beanstalk, Node.js 22, Amazon Linux 2023, and AWS RDS MySQL).

Deliver a comprehensive, production-grade 10/10 technical specification and implementation plan covering the following architectural dimensions:

1. Enterprise Layered Architecture:
   - Clean Architecture / DDD separation: Route -> Middleware -> Controller -> Service -> Repository -> Data Access.
   - Declarative Zod validation middleware decoupling validation from controllers.
   - Abstract Unit of Work (UoW) and Transaction Management for multi-write database queries without leaking connection pools or ORM primitives into services.
   - Domain-Driven custom AppError class hierarchy (ValidationError, NotFoundError, ConflictError, UnauthorizedError, DatabaseError) mapped to RFC 7807 problem details in a centralized error middleware.

2. Production Infrastructure & Elastic Beanstalk Hardening:
   - Zero-downtime rolling deployment strategies and graceful shutdown orchestration (SIGTERM/SIGINT with connection draining).
   - High-throughput PM2 Cluster Mode config (ecosystem.config.js) tuned for Amazon Linux 2023.
   - Optimized Nginx reverse proxy configuration: HTTP/2 protocol, Gzip compression, keep-alive upstream pools, buffer tuning, and custom rate-limiting zones.
   - Production AWS RDS MySQL SSL configuration: handling CA certificates securely without compromising TLS verification.

3. Observability & Security:
   - Request-scoped context propagation using native AsyncLocalStorage for correlation IDs and distributed request tracing.
   - Production security headers (Helmet, CORS, CSP), rate limiting, and parameter sanitization.

Format the output strictly as production-ready TypeScript code snippets, configuration files, and an architectural checklist. Avoid generic educational overviews—provide concrete, copy-pasteable implementations designed for high concurrency and enterprise audit readiness.
```

## Immediate implementation checklist

- [ ] Use this prompt to evaluate future KAIRO microservices.
- [ ] Refactor `auth`, `developer`, and `billing` modules toward the standardized Repository-Service-Controller pattern.
- [ ] Add automated load tests with `k6` or `autocannon` after the runtime and deployment changes are implemented.
- [ ] Record throughput, p95/p99 latency, error rate, connection-pool saturation, and memory per PM2 worker.
