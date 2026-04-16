/**
 * 如意收银 - 后端工具类
 */

class ApiResponse {
    static success(res, data = null, message = 'Success', code = 200) {
        return res.status(200).json({
            code,
            message,
            data,
            timestamp: Date.now()
        });
    }

    static error(res, message = 'Internal Server Error', code = 500, status = 500) {
        return res.status(status).json({
            code,
            message,
            data: null,
            timestamp: Date.now()
        });
    }
}

/**
 * 异步函数包装器，用于捕获错误并传递给 error-handling 中间件
 */
const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = {
    ApiResponse,
    asyncHandler
};
