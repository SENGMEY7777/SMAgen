'use strict';

const approveService = require('../../services/admins/approveService');
const { triggerScheduler } = require('../../core/scheduler');
const { executeTaskNode } = require('../../core/executor');
const { emitWorkflowEvent } = require('../../core/telemetry');
const sendResponse = require('../../utils/responseHelper');
const logger = require('../../utils/logger');

const listPending = async (req, res, next) => {
    try {
        const runId = req.validated?.query?.runId || req.query?.runId || null;
        const approvals = await approveService.listPendingApprovals(runId);

        return sendResponse(res, 200, true, 'Pending approvals retrieved successfully', approvals || []);
    } catch (error) {
        logger.error('Failed to retrieve pending approvals', error);
        return sendResponse(res, 200, true, 'Pending approvals retrieved successfully', []);
    }
};

const getById = async (req, res, next) => {
    try {
        const approval = await approveService.getApprovalById(req.validated.params.id);

        return sendResponse(res, 200, true, 'Approval request retrieved successfully', approval);
    } catch (error) {
        return next(error);
    }
};

const decide = async (req, res, next) => {
    try {
        const approval = await approveService.decideApproval({
            id: req.validated.params.id,
            status: req.body.status,
            rejectionReason: req.body.rejectionReason,
            resolverUserId: req.user.id,
            resolverRole: req.user.role,
        });

        const message = req.body.status === 'APPROVED'
            ? 'Approval request approved successfully'
            : 'Approval request rejected successfully';
        const io = req.app.get('io');

        if (io && approval.run_id) {
            emitWorkflowEvent({
                io,
                runId: approval.run_id,
                event: 'approval_decision',
                source: 'HITL',
                payload: {
                    runId: approval.run_id,
                    approvalId: approval.id,
                    taskId: approval.task_id,
                    nodeKey: approval.node_key,
                    status: approval.status,
                    rejectionReason: approval.rejection_reason,
                },
            });

            if (approval.status === 'REJECTED') {
                emitWorkflowEvent({
                    io,
                    runId: approval.run_id,
                    event: 'node_skipped',
                    source: 'HITL',
                    payload: {
                        runId: approval.run_id,
                        taskId: approval.task_id,
                        nodeKey: approval.node_key,
                        reason: approval.rejection_reason || 'Approval request was rejected',
                    },
                });
            }
        }

        if (approval.run_id) {
            triggerScheduler(approval.run_id, {
                io,
                executor: executeTaskNode,
            }).catch((scheduleError) => {
                logger.error('Approval resume scheduler failed', {
                    runId: approval.run_id,
                    error: scheduleError.message,
                });
            });
        }

        return sendResponse(res, 200, true, message, {
            approval,
            executionStarted: Boolean(approval.run_id),
        });
    } catch (error) {
        return next(error);
    }
};

module.exports = {
    listPending,
    getById,
    decide,
};
