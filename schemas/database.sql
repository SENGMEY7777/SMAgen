-- ====================================================================
-- SMAgen_db: ULTRA-HIGH PERFORMANCE & SECURE UNIFIED SCHEMA
-- ====================================================================
CREATE DATABASE IF NOT EXISTS SMAgen_db
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

USE SMAgen_db;

-- 1. USERS TABLE (Integrated OTP & Verification Columns)
CREATE TABLE IF NOT EXISTS users (
  id                       CHAR(36)         NOT NULL DEFAULT (UUID()),
  full_name                VARCHAR(100)     NOT NULL,
  email                    VARCHAR(191)     NOT NULL,
  phone_number             VARCHAR(20)      NULL,
  gender                   ENUM('MALE', 'FEMALE', 'OTHER') NULL,
  avatar_url               VARCHAR(255)     NULL,
  password_hash            CHAR(60)         NOT NULL,
  role                     ENUM('ADMIN', 'DEVELOPER', 'VIEWER') NOT NULL DEFAULT 'DEVELOPER',
  api_key_hash             CHAR(64)         NULL,
  
  -- Account Lifecycle & Security Gates
  token_version            INT UNSIGNED     NOT NULL DEFAULT 1,
  is_verified              TINYINT(1)       NOT NULL DEFAULT 0,
  is_active                TINYINT(1)       NOT NULL DEFAULT 1,
  failed_login_attempts    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  lockout_until            TIMESTAMP        NULL,
  last_login_at            TIMESTAMP        NULL,
  last_login_ip            VARCHAR(45)      NULL,

  -- Integrated OTP & Verification Columns
  verification_token       VARCHAR(255)     NULL,
  verification_expires     TIMESTAMP        NULL,
  password_reset_otp       VARCHAR(10)      NULL,
  password_reset_expires   TIMESTAMP        NULL,
  otp_attempts_count       TINYINT UNSIGNED NOT NULL DEFAULT 0,

  -- Audit Timestamps & Soft Delete
  created_at               TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at               TIMESTAMP        NULL,

  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  UNIQUE KEY uq_users_phone (phone_number),
  UNIQUE KEY uq_users_api_key (api_key_hash),
  
  -- Sub-Millisecond Indexes
  KEY idx_users_auth_lookup (email, is_active, deleted_at),
  KEY idx_users_role_status (role, is_active),
  KEY idx_users_otp_verify (email, password_reset_otp, password_reset_expires),
  KEY idx_users_lockout (lockout_until)
) ENGINE = InnoDB ROW_FORMAT = DYNAMIC;

-- 2. WORKFLOWS TABLE
CREATE TABLE IF NOT EXISTS workflows (
  id            CHAR(36)     NOT NULL DEFAULT (UUID()),
  user_id       CHAR(36)     NOT NULL,
  title         VARCHAR(255) NOT NULL,
  description   TEXT         NULL,
  system_prompt MEDIUMTEXT   NOT NULL,
  is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_workflows_user_active (user_id, is_active),
  CONSTRAINT fk_workflows_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE
) ENGINE = InnoDB ROW_FORMAT = DYNAMIC;

-- 3. EXECUTION_RUNS TABLE
CREATE TABLE IF NOT EXISTS execution_runs (
  id              CHAR(36)       NOT NULL DEFAULT (UUID()),
  workflow_id     CHAR(36)       NOT NULL,
  user_id         CHAR(36)       NOT NULL,
  status          ENUM('PENDING', 'RUNNING', 'AWAITING_APPROVAL', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED')
                  NOT NULL DEFAULT 'PENDING',
  goal_prompt     TEXT           NOT NULL,
  total_tokens    INT UNSIGNED   NOT NULL DEFAULT 0,
  total_cost_usd  DECIMAL(12, 6) NOT NULL DEFAULT 0.000000,
  started_at      TIMESTAMP      NULL,
  completed_at    TIMESTAMP      NULL,
  created_at      TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_runs_user_perf (user_id, status, created_at DESC),
  KEY idx_runs_workflow_perf (workflow_id, status, created_at DESC),
  KEY idx_runs_status_monitor (status, started_at),
  CONSTRAINT fk_runs_workflow
    FOREIGN KEY (workflow_id) REFERENCES workflows (id)
    ON DELETE CASCADE,
  CONSTRAINT fk_runs_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE
) ENGINE = InnoDB ROW_FORMAT = DYNAMIC;

-- 4. TASK_NODES TABLE (DAG Execution Nodes)
CREATE TABLE IF NOT EXISTS task_nodes (
  id                CHAR(36)         NOT NULL DEFAULT (UUID()),
  run_id            CHAR(36)         NOT NULL,
  node_key          VARCHAR(64)      NOT NULL,
  title             VARCHAR(255)     NOT NULL,
  instruction       TEXT             NOT NULL,
  dependencies      JSON             NOT NULL,
  status            ENUM('PENDING', 'QUEUED', 'RUNNING', 'AWAITING_APPROVAL', 'SUCCESS', 'FAILED', 'SKIPPED')
                    NOT NULL DEFAULT 'PENDING',
  assigned_tool     VARCHAR(64)      NOT NULL,
  tool_input        JSON             NULL,
  tool_output       JSON             NULL,
  error_message     TEXT             NULL,
  retry_count       TINYINT UNSIGNED NOT NULL DEFAULT 0,
  execution_time_ms INT UNSIGNED     NULL,
  started_at        TIMESTAMP        NULL,
  completed_at      TIMESTAMP        NULL,
  created_at        TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_tasks_run_node (run_id, node_key),
  KEY idx_tasks_scheduler (run_id, status, assigned_tool),
  CONSTRAINT fk_tasks_run
    FOREIGN KEY (run_id) REFERENCES execution_runs (id)
    ON DELETE CASCADE
) ENGINE = InnoDB ROW_FORMAT = DYNAMIC;

-- 5. APPROVAL_REQUESTS TABLE (HITL Checkpoints)
CREATE TABLE IF NOT EXISTS approval_requests (
  id                   CHAR(36)     NOT NULL DEFAULT (UUID()),
  task_id              CHAR(36)     NOT NULL,
  resolved_by_user_id  CHAR(36)     NULL,
  action_summary       TEXT         NOT NULL,
  risk_level           ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL') NOT NULL DEFAULT 'HIGH',
  status               ENUM('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED') NOT NULL DEFAULT 'PENDING',
  rejection_reason     TEXT         NULL,
  created_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at          TIMESTAMP    NULL,

  PRIMARY KEY (id),
  KEY idx_approvals_eval (task_id, status),
  KEY idx_approvals_queue (status, risk_level, created_at DESC),
  CONSTRAINT fk_approvals_task
    FOREIGN KEY (task_id) REFERENCES task_nodes (id)
    ON DELETE CASCADE,
  CONSTRAINT fk_approvals_resolver
    FOREIGN KEY (resolved_by_user_id) REFERENCES users (id)
    ON DELETE SET NULL
) ENGINE = InnoDB ROW_FORMAT = DYNAMIC;

-- 6. EXECUTION_LOGS TABLE (Real-time Telemetry Logs)
CREATE TABLE IF NOT EXISTS execution_logs (
  id         CHAR(36)  NOT NULL DEFAULT (UUID()),
  run_id     CHAR(36)  NOT NULL,
  level      ENUM('DEBUG', 'INFO', 'WARN', 'ERROR') NOT NULL DEFAULT 'INFO',
  source     ENUM('PLANNER', 'AGENT', 'TOOL', 'SANDBOX', 'HITL', 'SYSTEM') NOT NULL DEFAULT 'AGENT',
  message    TEXT      NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_logs_stream (run_id, created_at ASC),
  CONSTRAINT fk_logs_run
    FOREIGN KEY (run_id) REFERENCES execution_runs (id)
    ON DELETE CASCADE
) ENGINE = InnoDB ROW_FORMAT = DYNAMIC;

-- ====================================================================
-- SEED DEFAULT ADMIN USER
-- ====================================================================
INSERT INTO users (
    id, 
    full_name,
    email, 
    phone_number,
    password_hash, 
    role, 
    api_key_hash, 
    is_verified,
    is_active,
    created_at
)
VALUES (
    'usr_admin_001',
    'System Administrator',
    'smadmin10@gmail.com',
    '+85568832900',
    '$2b$10$hcM.ef5HMghxg05oJ3fDk.9.Yb5lEVpCQF0IjklAye7JeoSuR2UYC', -- Hash of 'SMAdmin@10'
    'ADMIN',
    SHA2('agy_live_admin_secret_key_001', 256),
    1,
    1,
    NOW()
)
ON DUPLICATE KEY UPDATE
    full_name = VALUES(full_name),
    password_hash = VALUES(password_hash),
    role = 'ADMIN',
    is_active = 1,
    is_verified = 1;