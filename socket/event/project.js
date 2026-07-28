const db = require("../../models");
const { getSessionUserId, hasPermission } = require("../session");

const PAGE_ACCESS_PERMISSION = "financial.page.access";

const stripProtectedFields = (data = {}) => {
    const { _id, createdAt, updatedAt, __v, ...update } = data;
    return update;
};

const readableError = (error) => {
    if (error?.code === 11000) return "A project with this ID already exists";
    if (error?.name === "ValidationError") return Object.values(error.errors).map(item => item.message).join(", ");
    if (error?.name === "CastError") return "Invalid project ID";
    return error.message;
};

module.exports = (socket, io) => {
    const requireUser = async (callback) => {
        const userId = getSessionUserId(socket);
        if (!userId) {
            callback({ status: "error", message: "Not authenticated" });
            return null;
        }

        const user = await db.user.findById(userId).lean();
        if (!user) {
            callback({ status: "error", message: "User not found" });
            return null;
        }
        if (!hasPermission(user, "access", PAGE_ACCESS_PERMISSION)) {
            callback({ status: "error", message: "You do not have permission to access finance" });
            return null;
        }
        return user;
    };

    socket.on("project:fetch", async (query = {}, callback) => {
        try {
            if (!await requireUser(callback)) return;
            const projects = await db.project.find(query).sort({ updatedAt: -1 });
            callback({ status: "success", message: "Projects fetched", payload: projects });
        } catch (error) {
            callback({ status: "error", message: readableError(error) });
        }
    });

    socket.on("project:get", async (query = {}, callback) => {
        try {
            if (!await requireUser(callback)) return;
            const project = await db.project.findOne(query);
            if (!project) return callback({ status: "error", message: "Project not found" });
            callback({ status: "success", message: "Project fetched", payload: project });
        } catch (error) {
            callback({ status: "error", message: readableError(error) });
        }
    });

    socket.on("project:create", async (data = {}, callback) => {
        try {
            if (!await requireUser(callback)) return;
            const project = await db.project.create(stripProtectedFields(data));
            callback({ status: "success", message: "Project created", payload: project });
        } catch (error) {
            callback({ status: "error", message: readableError(error) });
        }
    });

    socket.on("project:update", async (data = {}, callback) => {
        try {
            if (!await requireUser(callback)) return;
            const { _id } = data;
            if (!_id) return callback({ status: "error", message: "Project ID is required" });

            const project = await db.project.findByIdAndUpdate(
                _id,
                { $set: stripProtectedFields(data) },
                { new: true, runValidators: true },
            );
            if (!project) return callback({ status: "error", message: "Project not found" });
            callback({ status: "success", message: "Project updated", payload: project });
        } catch (error) {
            callback({ status: "error", message: readableError(error) });
        }
    });

    socket.on("project:delete", async ({ _id } = {}, callback) => {
        try {
            if (!await requireUser(callback)) return;
            if (!_id) return callback({ status: "error", message: "Project ID is required" });
            const linkedExpenses = await db.expense.exists({ projectId: _id });
            if (linkedExpenses)
                return callback({ status: "error", message: "Projects with linked expenses cannot be deleted" });

            const project = await db.project.findByIdAndDelete(_id);
            if (!project) return callback({ status: "error", message: "Project not found" });
            callback({ status: "success", message: "Project deleted" });
        } catch (error) {
            callback({ status: "error", message: readableError(error) });
        }
    });
};
