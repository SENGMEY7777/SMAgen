const pool = require('../../configs/db');

const ensureApprovalTable = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS approval_requests (
              id                   CHAR(36)     NOT NULL,
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
              KEY idx_approvals_queue (status, risk_level, created_at DESC)
            ) ENGINE = InnoDB ROW_FORMAT = DYNAMIC;
        `);
    } catch (e) {
        // Ignored if already exists or permission
    }
};

const createApprovalRequest = async ({id, taskId, actionSummary, riskLevel = 'HIGH'}) => {
    await ensureApprovalTable();
    await pool.query(
        `INSERT INTO approval_requests (id, task_id, action_summary, risk_level)
         VALUES (?, ?, ?, ?)`,
        [id, taskId, actionSummary, riskLevel],
    );

    return getApprovalById(id);
}

const getApprovalById = async (id) => {
    await ensureApprovalTable();
    if (String(id).startsWith('task-')) {
        const taskId = String(id).replace(/^task-/, '');
        try {
            const [rows] = await pool.query(
                `SELECT id AS task_id, run_id, node_key, title AS task_title,
                        assigned_tool, tool_input, status AS task_status,
                        instruction AS action_summary, created_at
                 FROM task_nodes WHERE id = ? LIMIT 1`,
                [taskId],
            );
            const t = rows[0];
            if (!t) return null;
            return {
                id,
                task_id: t.task_id,
                run_id: t.run_id,
                node_key: t.node_key,
                task_title: t.task_title,
                assigned_tool: t.assigned_tool,
                tool_input: t.tool_input,
                task_status: t.task_status,
                action_summary: t.action_summary,
                risk_level: 'HIGH',
                status: 'PENDING',
                created_at: t.created_at,
            };
        } catch {
            return null;
        }
    }

    try {
        const [rows] = await pool.query(
            `SELECT ar.*, tn.run_id, tn.node_key, tn.title AS task_title,
                    tn.assigned_tool, tn.tool_input, tn.status AS task_status
             FROM approval_requests ar
             JOIN task_nodes tn ON ar.task_id = tn.id
             WHERE ar.id = ?
             LIMIT 1`,
            [id],
        );
        return rows[0];
    } catch {
        return null;
    }
}

const listPendingApprovals = async (runId = null) => {
    await ensureApprovalTable();
    let rows = [];

    try {
        let sql = `
            SELECT ar.*, tn.run_id, tn.node_key, tn.title AS task_title,
                   tn.assigned_tool, tn.tool_input, tn.status AS task_status
            FROM approval_requests ar
            JOIN task_nodes tn ON ar.task_id = tn.id
            WHERE ar.status = 'PENDING'`;
        const params = [];

        if (runId) {
            sql += ' AND tn.run_id = ?';
            params.push(runId);
        }

        sql += ' ORDER BY ar.created_at DESC';

        const [dbRows] = await pool.query(sql, params);
        rows = Array.isArray(dbRows) ? dbRows : [];
    } catch (err) {
        console.warn('⚠️ [listPendingApprovals query warn]:', err.message);
    }

    // Also include any tasks with status 'AWAITING_APPROVAL' in task_nodes
    try {
        let taskSql = `
            SELECT tn.id AS task_id, tn.run_id, tn.node_key, tn.title AS task_title,
                   tn.assigned_tool, tn.tool_input, tn.status AS task_status,
                   tn.instruction AS action_summary, tn.created_at
            FROM task_nodes tn
            WHERE tn.status = 'AWAITING_APPROVAL'`;
        const taskParams = [];

        if (runId) {
            taskSql += ' AND tn.run_id = ?';
            taskParams.push(runId);
        }

        const [taskRows] = await pool.query(taskSql, taskParams);
        const existingTaskIds = new Set(rows.map((r) => String(r.task_id)));

        for (const t of taskRows || []) {
            if (!existingTaskIds.has(String(t.task_id))) {
                rows.push({
                    id: `task-${t.task_id}`,
                    task_id: t.task_id,
                    run_id: t.run_id,
                    node_key: t.node_key,
                    task_title: t.task_title,
                    assigned_tool: t.assigned_tool,
                    tool_input: t.tool_input,
                    task_status: t.task_status,
                    action_summary: t.action_summary,
                    risk_level: 'HIGH',
                    status: 'PENDING',
                    created_at: t.created_at,
                });
            }
        }
    } catch (taskErr) {
        console.warn('⚠️ [listPendingApprovals task_nodes fallback warn]:', taskErr.message);
    }

    return rows;
}

const getLatestApprovalByTaskId = async (taskId) => {
    const [rows] = await pool.query(
        `SELECT id, task_id, status, risk_level, action_summary, rejection_reason,
                created_at, resolved_at
         FROM approval_requests
         WHERE task_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
        [taskId],
    );

    return rows[0];
}

const resolveApproval = async ({id, status, resolverUserId, rejectionReason = null}) => {
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        if (String(id).startsWith('task-')) {
            const taskId = String(id).replace(/^task-/, '');
            const [taskRows] = await connection.query(
                `SELECT id, run_id, node_key, title, status FROM task_nodes WHERE id = ? LIMIT 1 FOR UPDATE`,
                [taskId],
            );
            const task = taskRows[0];
            if (!task) {
                await connection.rollback();
                return { approval: null, updated: false };
            }

            const taskStatus = status === 'APPROVED' ? 'PENDING' : 'SKIPPED';
            const errorMessage = status === 'APPROVED' ? null : rejectionReason || 'Approval request was rejected';
            await connection.query(
                `UPDATE task_nodes SET status = ?, error_message = ?, completed_at = ? WHERE id = ?`,
                [taskStatus, errorMessage, status === 'REJECTED' ? new Date() : null, taskId],
            );
            await connection.commit();

            return {
                approval: {
                    id,
                    task_id: taskId,
                    run_id: task.run_id,
                    node_key: task.node_key,
                    status,
                    rejection_reason: rejectionReason,
                },
                updated: true,
            };
        }

        const [approvalRows] = await connection.query(
            `SELECT ar.id, ar.task_id, ar.status, tn.run_id
             FROM approval_requests ar
             JOIN task_nodes tn ON ar.task_id = tn.id
             WHERE ar.id = ?
             LIMIT 1
             FOR UPDATE`,
            [id],
        );

        const approval = approvalRows[0];

        if (!approval) {
            await connection.rollback();

            return {
                approval: null,
                updated: false,
            };
        }

        if (approval.status !== 'PENDING') {
            await connection.rollback();

            return {
                approval,
                updated: false,
            };
        }

        await connection.query(
            `UPDATE approval_requests
             SET status = ?,
                 resolved_by_user_id = ?,
                 rejection_reason = ?,
                 resolved_at = NOW()
             WHERE id = ?`,
            [status, resolverUserId, status === 'REJECTED' ? rejectionReason : null, id],
        );

        const taskStatus = status === 'APPROVED' ? 'PENDING' : 'SKIPPED';
        const errorMessage = status === 'APPROVED'
            ? null
            : rejectionReason || 'Approval request was rejected';

        await connection.query(
            `UPDATE task_nodes
             SET status = ?,
                 error_message = ?,
                 completed_at = ?
             WHERE id = ?`,
            [
                taskStatus,
                errorMessage,
                status === 'REJECTED' ? new Date() : null,
                approval.task_id,
            ],
        );

        await connection.commit();

        return {
            approval: await getApprovalById(id),
            updated: true,
        };
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

module.exports = {
    createApprovalRequest,
    getApprovalById,
    listPendingApprovals,
    getLatestApprovalByTaskId,
    resolveApproval,
};
