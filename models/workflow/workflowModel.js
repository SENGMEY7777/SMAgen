const pool = require('../../configs/db');

const create = async ({id, title, description = null, systemPrompt, userId}) => {
    await pool.query(
        `INSERT INTO workflows (id, user_id, title, description, system_prompt)
         VALUES (?, ?, ?, ?, ?)`,
        [id, userId, title, description, systemPrompt],
    );

    const [rows] = await pool.query(
        `SELECT id, user_id, title, description, system_prompt, is_active, created_at, updated_at
         FROM workflows
         WHERE id = ?
         LIMIT 1`,
        [id],
    );

    return rows[0];
}

const listWorkflowsByUser = async (userId) => {
    const [rows] = await pool.query(
        `SELECT id, user_id, title, description, system_prompt, is_active, created_at, updated_at
         FROM workflows
         WHERE user_id = ?
           AND is_active = 1
         ORDER BY created_at DESC`,
        [userId],
    );

    return rows;
}

const getWorkflowById = async (id, userId) => {
    const [rows] = await pool.query(
        `SELECT id, user_id, title, description, system_prompt, is_active, created_at, updated_at
         FROM workflows
         WHERE id = ?
           AND user_id = ?
           AND is_active = 1
         LIMIT 1`,
        [id, userId],
    );

    return rows[0];
}

const createExecutionRun = async ({id, workflowId = null, userId, goalPrompt, status='PENDING'}) => {
    await pool.query(
        `INSERT INTO execution_runs (id, workflow_id, user_id, goal_prompt, status)
         VALUES (?, ?, ?, ?, ?)`,
        [id, workflowId, userId, goalPrompt, status],
    );

    return getExecutionById(id, userId);
}

const getExecutionById = async (id, userId = null) => {
    let sql = `
        SELECT id, workflow_id, user_id, goal_prompt, status, started_at, completed_at,
               total_tokens, total_cost_usd, created_at
        FROM execution_runs
        WHERE id = ?`;
    const values = [id];

    if (userId) {
        sql += ' AND user_id = ?';
        values.push(userId);
    }

    sql += ' LIMIT 1';

    const [rows] = await pool.query(sql, values);

    return rows[0];
}

const updateExecutionRunStatus = async (id, status, extra = {}) => {
    const updates = ['status = ?'];
    const values = [status];

    if (status === 'RUNNING') {
        updates.push('started_at = COALESCE(started_at, NOW())');
    } else if (status === 'COMPLETED' || status === 'FAILED') {
        updates.push('completed_at = NOW()');
    }

    if (extra.totalTokens !== undefined) {
        updates.push('total_tokens = ?');
        values.push(extra.totalTokens);
    }

    if (extra.totalCostUsd !== undefined) {
        updates.push('total_cost_usd = ?');
        values.push(extra.totalCostUsd);
    }

    values.push(id);

    const sql = `UPDATE execution_runs SET ${updates.join(', ')} WHERE id = ?`;
    const [result] = await pool.query(sql, values);

    return result;
}

const listExecutionRunsByUser = async (userId) => {
    const [rows] = await pool.query(
        `SELECT id, workflow_id, goal_prompt, status, started_at, completed_at, total_tokens, total_cost_usd, created_at
         FROM execution_runs
         WHERE user_id = ?
         ORDER BY created_at DESC`,
        [userId],
    );

    return rows;
}

const listTaskNodesByRunId = async (runId) => {
    const [rows] = await pool.query(
        `SELECT id, run_id, node_key, title, instruction, dependencies, status,
                assigned_tool, tool_input, tool_output, error_message, retry_count,
                execution_time_ms, started_at, completed_at, created_at
         FROM task_nodes
         WHERE run_id = ?
         ORDER BY created_at ASC`,
        [runId],
    );

    return rows;
}

const bulkInsertTaskNodes = async (tasks) => {
    if (!tasks.length) {
        return {
            affectedRows: 0,
        };
    }

    const placeholders = tasks.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const values = tasks.flatMap((task) => [
        task.id,
        task.runId,
        task.nodeKey,
        task.title,
        task.instruction,
        JSON.stringify(task.dependencies || []),
        task.assignedTool,
        JSON.stringify(task.toolInput || {}),
        task.status || 'PENDING',
        task.retryCount || 0,
    ]);

    const sql = `
        INSERT INTO task_nodes (
            id,
            run_id,
            node_key,
            title,
            instruction,
            dependencies,
            assigned_tool,
            tool_input,
            status,
            retry_count
        )
        VALUES ${placeholders}`;

    const [result] = await pool.query(sql, values);

    return result;
}

module.exports = {
    create,
    listWorkflowsByUser,
    getWorkflowById,
    createExecutionRun,
    updateExecutionRunStatus,
    getExecutionById,
    listExecutionRunsByUser,
    listTaskNodesByRunId,
    bulkInsertTaskNodes,
}
