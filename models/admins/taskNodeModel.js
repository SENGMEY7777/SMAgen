// models/taskNodeModel.js
import { pool } from '../configs/db.js';


export async function bulkInsertTaskNodes(tasks) {
  if (!tasks || tasks.length === 0) return;

  const sql = `
    INSERT INTO task_nodes (
      id, run_id, node_key, title, instruction, dependencies,
      status, assigned_tool, tool_input, retry_count, created_at
    ) VALUES ?
  `;

  const values = tasks.map(task => [
    task.id,
    task.runId || task.run_id,
    task.nodeKey || task.node_key,
    task.title,
    task.instruction,
    JSON.stringify(task.dependencies || []),
    task.status || 'PENDING',
    task.assignedTool || task.assigned_tool,
    JSON.stringify(task.toolInput || task.tool_input || {}),
    task.retryCount || task.retry_count || 0,
    new Date()
  ]);

  const [result] = await pool.query(sql, [values]);
  return result;
}

/**
 * 2. Get all task nodes for a specific execution run
 */
export async function getTaskNodesByRunId(runId) {
  const sql = `
    SELECT id, run_id, node_key, title, instruction, dependencies,
           status, assigned_tool, tool_input, tool_output, error_message,
           retry_count, execution_time_ms, started_at, completed_at, created_at
    FROM task_nodes
    WHERE run_id = ?
    ORDER BY created_at ASC
  `;
  const [rows] = await pool.query(sql, [runId]);
  return rows;
}

/**
 * 3. Get single task node by ID
 */
export async function getTaskNodeById(taskId) {
  const sql = `
    SELECT id, run_id, node_key, title, instruction, dependencies,
           status, assigned_tool, tool_input, tool_output, error_message,
           retry_count, execution_time_ms, started_at, completed_at, created_at
    FROM task_nodes
    WHERE id = ?
    LIMIT 1
  `;
  const [rows] = await pool.query(sql, [taskId]);
  return rows[0] || null;
}

/**
 * 4. Update task node dynamically
 */
export async function updateTaskNode(taskId, updates) {
  const fields = [];
  const values = [];

  if (updates.status) {
    fields.push('status = ?');
    values.push(updates.status);
    if (updates.status === 'RUNNING') fields.push('started_at = COALESCE(started_at, NOW())');
    if (['SUCCESS', 'FAILED', 'SKIPPED'].includes(updates.status)) fields.push('completed_at = NOW()');
  }

  if (updates.toolOutput !== undefined || updates.tool_output !== undefined) {
    const output = updates.toolOutput !== undefined ? updates.toolOutput : updates.tool_output;
    fields.push('tool_output = ?');
    values.push(typeof output === 'string' ? output : JSON.stringify(output));
  }

  if (updates.errorMessage !== undefined || updates.error_message !== undefined) {
    const errorMsg = updates.errorMessage !== undefined ? updates.errorMessage : updates.error_message;
    fields.push('error_message = ?');
    values.push(errorMsg);
  }

  if (updates.executionTimeMs !== undefined || updates.execution_time_ms !== undefined) {
    const timeMs = updates.executionTimeMs !== undefined ? updates.executionTimeMs : updates.execution_time_ms;
    fields.push('execution_time_ms = ?');
    values.push(timeMs);
  }

  if (updates.retryCount !== undefined || updates.retry_count !== undefined) {
    const retries = updates.retryCount !== undefined ? updates.retryCount : updates.retry_count;
    fields.push('retry_count = ?');
    values.push(retries);
  }

  if (fields.length === 0) return;

  values.push(taskId);
  const sql = `UPDATE task_nodes SET ${fields.join(', ')} WHERE id = ?`;
  const [result] = await pool.query(sql, values);
  return result;
}

/**
 * 5. Mark task as SUCCESS
 */
export async function markTaskSuccess(taskId, output, executionTimeMs) {
  return await updateTaskNode(taskId, {
    status: 'SUCCESS',
    toolOutput: output,
    executionTimeMs
  });
}