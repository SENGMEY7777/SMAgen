const approveModel = require('../../models/admins/approveModel');

const createApprovalRequest = async ({id, taskId, actionSummary, riskLevel = 'HIGH'}) => {
    return approveModel.createApprovalRequest({
        id,
        taskId,
        actionSummary,
        riskLevel,
    });
}

const getApprovalById = async (id) => {
    const approval = await approveModel.getApprovalById(id);

    if (!approval) {
        const error = new Error('Approval request not found');
        error.code = 'APPROVAL_NOT_FOUND';
        throw error;
    }

    return approval;
}

const listPendingApprovals = async (runId = null) => {
    return approveModel.listPendingApprovals(runId);
}

const decideApproval = async ({
    id,
    status,
    resolverUserId,
    resolverRole,
    rejectionReason = null,
}) => {
    const normalizedRole = String(resolverRole || '').trim().toUpperCase();

    if (!['ADMIN', 'OPERATOR', 'DEVELOPER'].includes(normalizedRole)) {
        const error = new Error('Only ADMIN, OPERATOR, or DEVELOPER users can approve or reject tasks');
        error.code = 'FORBIDDEN';
        throw error;
    }

    if (!['APPROVED', 'REJECTED'].includes(status)) {
        const error = new Error('Approval status must be APPROVED or REJECTED');
        error.code = 'INVALID_APPROVAL_STATUS';
        throw error;
    }

    if (status === 'REJECTED' && !String(rejectionReason || '').trim()) {
        const error = new Error('A rejection reason is required');
        error.code = 'REJECTION_REASON_REQUIRED';
        throw error;
    }

    const result = await approveModel.resolveApproval({
        id,
        status,
        resolverUserId,
        rejectionReason: rejectionReason ? String(rejectionReason).trim() : null,
    });

    if (!result.approval) {
        const error = new Error('Approval request not found');
        error.code = 'APPROVAL_NOT_FOUND';
        throw error;
    }

    if (!result.updated) {
        const error = new Error(`Approval request is already ${result.approval.status.toLowerCase()}`);
        error.code = 'APPROVAL_ALREADY_RESOLVED';
        throw error;
    }

    return result.approval;
}

module.exports = {
    createApprovalRequest,
    getApprovalById,
    listPendingApprovals,
    decideApproval,
};
