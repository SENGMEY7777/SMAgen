-- KAIRO performance indexes.
-- Idempotent: run against the selected KAIRO schema after taking the normal
-- RDS backup/snapshot. Existing KAIRO schemas already cover users.email with
-- uq_users_email and idx_users_auth_lookup, so the first block is a no-op.

SET @users_email_index_sql = (
    SELECT CASE
        WHEN EXISTS (
            SELECT 1
            FROM information_schema.tables
            WHERE table_schema = DATABASE()
              AND table_name = 'users'
        ) AND EXISTS (
            SELECT 1
            FROM information_schema.statistics
            WHERE table_schema = DATABASE()
              AND table_name = 'users'
              AND column_name = 'email'
              AND seq_in_index = 1
        ) THEN 'SELECT 1'
        WHEN EXISTS (
            SELECT 1
            FROM information_schema.tables
            WHERE table_schema = DATABASE()
              AND table_name = 'users'
        ) THEN 'ALTER TABLE users ADD INDEX idx_users_email (email)'
        ELSE 'SELECT 1'
    END
);
PREPARE users_email_index_stmt FROM @users_email_index_sql;
EXECUTE users_email_index_stmt;
DEALLOCATE PREPARE users_email_index_stmt;

SET @developer_profile_index_sql = (
    SELECT CASE
        WHEN EXISTS (
            SELECT 1
            FROM information_schema.tables
            WHERE table_schema = DATABASE()
              AND table_name = 'developer_profiles'
        ) AND EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'developer_profiles'
              AND column_name = 'user_id'
        ) AND EXISTS (
            SELECT 1
            FROM information_schema.statistics
            WHERE table_schema = DATABASE()
              AND table_name = 'developer_profiles'
              AND column_name = 'user_id'
              AND seq_in_index = 1
        ) THEN 'SELECT 1'
        WHEN EXISTS (
            SELECT 1
            FROM information_schema.tables
            WHERE table_schema = DATABASE()
              AND table_name = 'developer_profiles'
        ) AND EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = 'developer_profiles'
              AND column_name = 'user_id'
        ) THEN 'ALTER TABLE developer_profiles ADD INDEX idx_dev_user_id (user_id)'
        ELSE 'SELECT 1'
    END
);
PREPARE developer_profile_index_stmt FROM @developer_profile_index_sql;
EXECUTE developer_profile_index_stmt;
DEALLOCATE PREPARE developer_profile_index_stmt;
