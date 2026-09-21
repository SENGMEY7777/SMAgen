const sendResponse = (res, statusCode, success, message, data = null, error = null) => {
    const body = {
        success: Boolean(success),
        message,
    };

    if (data !== null && data !== undefined) {
        body.data = data;
    }

    if (!success && error) {
        body.error = error;
    }

    return res.status(statusCode).json(body);
};

module.exports = sendResponse;
