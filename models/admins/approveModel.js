const pool = require('../../configs/db');

const createApprovalRequest = async ({id, taskId, actionSummary, riskLevel = 'HIGH'}) => {
    await pool.query(
        `INSERT INTO approval_requests (id, task_id, action_summary, risk_level)
         VALUES (?, ?, ?, ?)`,
        [id, taskId, actionSummary, riskLevel],
    );

    return getApprovalById(id);
}

const getApprovalById = async (id) => {
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
}

const listPendingApprovals = async (runId = null) => {
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

    const [rows] = await pool.query(sql, params);

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
