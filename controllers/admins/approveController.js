const approveService = require('../../services/admins/approveService');
const {triggerScheduler} = require('../../core/scheduler');
const {executeTaskNode} = require('../../core/executor');
const sendResponse = require('../../utils/responseHelper');

const getApprovalErrorStatus = (code) => ({
    APPROVAL_NOT_FOUND: 404,
    APPROVAL_ALREADY_RESOLVED: 409,
    INVALID_APPROVAL_STATUS: 400,
    REJECTION_REASON_REQUIRED: 400,
}[code] || 500);

const listPending = async (req, res) => {
    try {
        const runId = req.validated?.query?.runId || null;
        const approvals = await approveService.listPendingApprovals(runId);

        return sendResponse(res, 200, true, 'Pending approvals retrieved successfully', approvals);
    } catch (error) {
        return sendResponse(res, 500, false, 'Failed to retrieve pending approvals', null, {
            code: 'APPROVAL_LIST_ERROR',
        });
    }
};

const getById = async (req, res) => {
    try {
        const approval = await approveService.getApprovalById(req.validated.params.id);

        return sendResponse(res, 200, true, 'Approval request retrieved successfully', approval);
    } catch (error) {
        const statusCode = getApprovalErrorStatus(error.code);

        return sendResponse(res, statusCode, false, error.message, null, {
            code: error.code || 'APPROVAL_DETAILS_ERROR',
        });
    }
};

const decide = async (req, res) => {
    try {
        const approval = await approveService.decideApproval({
            id: req.validated.params.id,
            status: req.body.status,
            rejectionReason: req.body.rejectionReason,
            resolverUserId: req.user.id,
        });

        const message = req.body.status === 'APPROVED'
            ? 'Approval request approved successfully'
            : 'Approval request rejected successfully';

        if (approval.run_id) {
            triggerScheduler(approval.run_id, {
                executor: executeTaskNode,
            }).catch((error) => {
                console.error(`❌ [Approval Resume Error]:`, error.message);
            });
        }

        return sendResponse(res, 200, true, message, {
            approval,
            executionStarted: Boolean(approval.run_id),
        });
    } catch (error) {
        const statusCode = getApprovalErrorStatus(error.code);

        return sendResponse(res, statusCode, false, error.message, null, {
            code: error.code || 'APPROVAL_DECISION_ERROR',
        });
    }
};

module.exports = {
    listPending,
    getById,
    decide,
};
