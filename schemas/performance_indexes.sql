-- Idempotent authentication lookup indexes for existing deployments.
-- The current schema already has uq_users_email and the composite
-- idx_users_auth_lookup index, so this migration does not add a redundant
-- single-column index when either one already starts with email.

USE SMAgen_db;

SET @sql = (
    SELECT IF(
        EXISTS (
            SELECT 1
            FROM information_schema.statistics
            WHERE table_schema = DATABASE()
              AND table_name = 'users'
              AND column_name = 'email'
              AND seq_in_index = 1
        ),
        'SELECT 1',
        'ALTER TABLE users ADD INDEX idx_users_email (email)'
    )
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- developer_profiles is not part of the unified schema. If a deployment has
-- that optional table, add the foreign-key lookup index only when needed.
SET @sql = (
    SELECT IF(
        NOT EXISTS (
            SELECT 1
            FROM information_schema.tables
            WHERE table_schema = DATABASE()
              AND table_name = 'developer_profiles'
        )
        OR EXISTS (
            SELECT 1
            FROM information_schema.statistics
            WHERE table_schema = DATABASE()
              AND table_name = 'developer_profiles'
              AND column_name = 'user_id'
              AND seq_in_index = 1
        ),
        'SELECT 1',
        'ALTER TABLE developer_profiles ADD INDEX idx_dev_user_id (user_id)'
    )
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
