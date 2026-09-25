# AI Agent Workflow API

An Express.js AI workflow platform that plans user goals as DAG workflows, executes approved tools, streams telemetry through WebSocket, and supports self-healing retries.

## Features

- LLM-powered workflow planning with Gemini.
- DAG task scheduling and sandboxed workspace execution.
- Human-in-the-loop approval for risky operations.
- Self-healing retries for failed tasks.
- MySQL persistence with parameterized queries.
- JWT authentication with token-version invalidation.
- Role-based access control for `ADMIN`, `OPERATOR`, and `DEVELOPER` users.
- Sensitive-data masking for telemetry logs and WebSocket events.
- Command blacklist, path-traversal protection, timeouts, and rate limiting.

## Requirements

- Node.js 20+
- MySQL 8+
- Gemini API key

## Installation

```bash
git clone <repository-url>
cd AI-Agent
npm install
cp .env.example .env
```

Configure `.env` with local values. Never commit `.env` or print its secrets.

Required configuration includes:

```env
NODE_ENV=development
PORT=3000
APP_URL=http://localhost:3000
CORS_ORIGIN=http://localhost:3000

DB_HOST=localhost
DB_PORT=3306
DB_NAME=SMAgen_db
DB_USER=ai_agent
DB_PASSWORD=your_database_password

JWT_SECRET=your_long_random_secret_at_least_32_characters
GEMINI_API_KEY=your_gemini_api_key
```

Create the database and application user using a MySQL administrator account, then import `schemas/database.sql`.

## Run

```bash
node app.js
```

The API runs at:

```text
http://localhost:3000
```

The same server now serves the OmniAgent dashboard at `http://localhost:3000/`.
Sign in with a developer account, then use `Auto` mode for normal Q&A or
`Workflow` mode for a DAG plan with task status and telemetry. The general chat
API is available at:

```http
POST /api/v1/chat
```

It requires the same Bearer JWT as the workflow endpoints and accepts a
`message` plus an optional short `history` array.

## Authentication

Send the JWT in the request header:

```http
Authorization: Bearer <token>
```

### Developer authentication

```http
POST /api/v1/developers/register
POST /api/v1/developers/login
DELETE /api/v1/developers/logout
```

### Admin authentication

```http
POST /api/v1/admin/auth/login
DELETE /api/v1/admin/auth/logout
```

Passwords must contain at least 8 characters, uppercase and lowercase letters, a number, and one of `@$!%*?&`.

## Workflow API

Both `/workflow` and `/workflows` prefixes are supported.

```http
POST /api/v1/workflows/create
GET  /api/v1/workflows/listWorkflows
POST /api/v1/workflows/run
POST /api/v1/workflows/run/:runId
GET  /api/v1/workflows/runs
GET  /api/v1/workflows/runs/:runId
```

Example workflow run request:

```bash
curl -X POST http://localhost:3000/api/v1/workflows/run \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"goalPrompt":"List the files in the workspace"}'
```

## Approval API

Only `ADMIN` and `OPERATOR` users can approve or reject risky tasks. `DEVELOPER` users receive `403 FORBIDDEN`.

```http
GET  /api/v1/admin/approvals/pending
GET  /api/v1/admin/approvals/:id
POST /api/v1/admin/approvals/:id/decision
```

## WebSocket telemetry

Connect to the same server with a valid JWT, then join a workflow run:

```js
socket.emit('join_run', runId, (response) => {
  console.log(response);
});

socket.on('telemetry', (data) => {
  console.log(data);
});
```

Telemetry masks API keys, JWTs, bearer tokens, passwords, and database connection strings before database persistence or WebSocket emission.

## Security controls

- `helmet` security headers and restricted CORS.
- Authentication rate limit: 5 login/register attempts per IP every 15 minutes.
- Workflow rate limit: 20 workflow triggers per user every hour.
- Prepared SQL statements with `?` placeholders only.
- Dangerous command blocking and a hard 30-second command timeout.
- Workspace path-traversal and symlink checks.
- API keys are stored as SHA-256 hashes; the raw key is returned only once.
- Incrementing `token_version` invalidates all existing JWTs for a user.
- Approval actions are restricted to `ADMIN` and `OPERATOR` roles.

## Validation

Run JavaScript syntax and whitespace checks:

```bash
rg --files -g '*.js' -g '!node_modules' -g '!workspaces/**' | xargs -n1 node --check
git diff --check
```

## Important security notes

- Keep `.env` out of Git.
- Use a dedicated MySQL user instead of `root`.
- Use `NODE_ENV=production`, HTTPS, explicit CORS, SMTP credentials, and database TLS in production.
- Rotate any credential that was accidentally exposed in a terminal, screenshot, log, or chat.
