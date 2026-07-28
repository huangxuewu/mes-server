const db = require("../../models");
const { getSessionUserId, hasPermission } = require("../session");

const PAGE_ACCESS_PERMISSION = "financial.page.access";
const APPROVE_PERMISSION = "finance.expense.payment.approve";

const actorName = (user) => user.displayName || user.username || String(user._id);

const stripProtectedFields = (data = {}) => {
    const {
        _id, expenseNumber, approvalStatus, paymentStatus, decisionHistory,
        processDate, paymentMethod, paymentReference, handler,
        createdAt, updatedAt, __v, ...update
    } = data;
    return update;
};

const readableError = (error) => {
    if (error?.code === 11000) return "An expense with this expense number already exists";
    if (error?.name === "ValidationError") return Object.values(error.errors).map(item => item.message).join(", ");
    if (error?.name === "CastError") return `Invalid ${error.path || "ID"}`;
    return error.message;
};

module.exports = (socket, io) => {
    const requireUser = async (callback, approve = false) => {
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
        if (approve && !hasPermission(user, "approve", APPROVE_PERMISSION)) {
            callback({ status: "error", message: "You do not have permission to approve or reject expenses" });
            return null;
        }
        return user;
    };

    const nextExpenseNumber = async () => {
        const year = new Date().getUTCFullYear();
        const counter = await db.counter.findByIdAndUpdate(
            `expense:${year}`,
            { $inc: { sequence: 1 } },
            { new: true, upsert: true, setDefaultsOnInsert: true },
        );
        return `EXP-${year}-${String(counter.sequence).padStart(5, "0")}`;
    };

    const resolveProject = async (projectId) => {
        if (!projectId) return null;
        const project = await db.project.findById(projectId).select("name").lean();
        if (!project) throw new Error("Referenced project not found");
        return project;
    };

    const historyEntry = (action, user, message = "") => ({
        action,
        at: new Date(),
        actor: actorName(user),
        userId: user._id,
        message: String(message || "").trim(),
    });

    socket.on("expense:fetch", async (query = {}, callback) => {
        try {
            if (!await requireUser(callback)) return;
            const expenses = await db.expense.find(query).sort({ date: -1, expenseNumber: -1 });
            callback({ status: "success", message: "Expenses fetched", payload: expenses });
        } catch (error) {
            callback({ status: "error", message: readableError(error) });
        }
    });

    socket.on("expense:get", async (query = {}, callback) => {
        try {
            if (!await requireUser(callback)) return;
            const expense = await db.expense.findOne(query);
            if (!expense) return callback({ status: "error", message: "Expense not found" });
            callback({ status: "success", message: "Expense fetched", payload: expense });
        } catch (error) {
            callback({ status: "error", message: readableError(error) });
        }
    });

    socket.on("expense:create", async (data = {}, callback) => {
        try {
            const user = await requireUser(callback);
            if (!user) return;

            const create = stripProtectedFields(data);
            const project = await resolveProject(create.projectId);
            create.projectName = project?.name || "";

            create.expenseNumber = await nextExpenseNumber();
            create.approvalStatus = "Pending";
            create.paymentStatus = "Unpaid";
            create.decisionHistory = [historyEntry("Submitted", user, data.message)];

            const expense = await db.expense.create(create);
            callback({ status: "success", message: "Expense created and submitted", payload: expense });
        } catch (error) {
            callback({ status: "error", message: readableError(error) });
        }
    });

    socket.on("expense:update", async (data = {}, callback) => {
        try {
            if (!await requireUser(callback)) return;
            const { _id } = data;
            if (!_id) return callback({ status: "error", message: "Expense ID is required" });
            const current = await db.expense.findById(_id).select("approvalStatus paymentStatus");
            if (!current) return callback({ status: "error", message: "Expense not found" });
            if (current.approvalStatus === "Approved" || current.paymentStatus === "Paid")
                return callback({ status: "error", message: "Approved or paid expenses cannot be edited" });

            const update = stripProtectedFields(data);
            if (Object.prototype.hasOwnProperty.call(update, "projectId")) {
                const project = await resolveProject(update.projectId);
                update.projectName = project?.name || "";
            }

            const expense = await db.expense.findByIdAndUpdate(
                _id,
                { $set: update },
                { new: true, runValidators: true },
            );
            if (!expense) return callback({ status: "error", message: "Expense not found" });
            callback({ status: "success", message: "Expense updated", payload: expense });
        } catch (error) {
            callback({ status: "error", message: readableError(error) });
        }
    });

    socket.on("expense:delete", async ({ _id } = {}, callback) => {
        try {
            if (!await requireUser(callback)) return;
            if (!_id) return callback({ status: "error", message: "Expense ID is required" });

            const expense = await db.expense.findById(_id).select("paymentStatus");
            if (!expense) return callback({ status: "error", message: "Expense not found" });
            if (expense.paymentStatus === "Paid")
                return callback({ status: "error", message: "Paid expenses cannot be deleted" });

            await expense.deleteOne();
            callback({ status: "success", message: "Expense deleted" });
        } catch (error) {
            callback({ status: "error", message: readableError(error) });
        }
    });

    socket.on("expense:submit", async ({ _id, message } = {}, callback) => {
        try {
            const user = await requireUser(callback);
            if (!user) return;
            if (!_id) return callback({ status: "error", message: "Expense ID is required" });

            const expense = await db.expense.findOneAndUpdate(
                { _id, approvalStatus: "Rejected", paymentStatus: "Unpaid" },
                {
                    $set: { approvalStatus: "Pending" },
                    $push: { decisionHistory: historyEntry("Submitted", user, message) },
                },
                { new: true, runValidators: true },
            );
            if (!expense)
                return callback({ status: "error", message: "Only rejected, unpaid expenses may be resubmitted" });
            callback({ status: "success", message: "Expense submitted", payload: expense });
        } catch (error) {
            callback({ status: "error", message: readableError(error) });
        }
    });

    socket.on("expense:approve", async ({ _id, message } = {}, callback) => {
        try {
            const user = await requireUser(callback, true);
            if (!user) return;
            if (!_id) return callback({ status: "error", message: "Expense ID is required" });

            const expense = await db.expense.findOneAndUpdate(
                { _id, approvalStatus: "Pending", paymentStatus: "Unpaid" },
                {
                    $set: { approvalStatus: "Approved" },
                    $push: { decisionHistory: historyEntry("Approved", user, message) },
                },
                { new: true, runValidators: true },
            );
            if (!expense)
                return callback({ status: "error", message: "Only pending, unpaid expenses may be approved" });
            callback({ status: "success", message: "Expense approved", payload: expense });
        } catch (error) {
            callback({ status: "error", message: readableError(error) });
        }
    });

    socket.on("expense:reject", async ({ _id, message } = {}, callback) => {
        try {
            const user = await requireUser(callback, true);
            if (!user) return;
            if (!_id) return callback({ status: "error", message: "Expense ID is required" });
            if (!String(message || "").trim())
                return callback({ status: "error", message: "A rejection message is required" });

            const expense = await db.expense.findOneAndUpdate(
                { _id, approvalStatus: "Pending", paymentStatus: "Unpaid" },
                {
                    $set: { approvalStatus: "Rejected" },
                    $push: { decisionHistory: historyEntry("Rejected", user, message) },
                },
                { new: true, runValidators: true },
            );
            if (!expense)
                return callback({ status: "error", message: "Only pending, unpaid expenses may be rejected" });
            callback({ status: "success", message: "Expense rejected", payload: expense });
        } catch (error) {
            callback({ status: "error", message: readableError(error) });
        }
    });

    socket.on("expense:pay", async ({ _id, processDate, paymentMethod, paymentReference } = {}, callback) => {
        try {
            const user = await requireUser(callback);
            if (!user) return;
            if (!_id) return callback({ status: "error", message: "Expense ID is required" });
            if (!String(paymentMethod || "").trim())
                return callback({ status: "error", message: "Payment method is required" });
            if (!String(paymentReference || "").trim())
                return callback({ status: "error", message: "Payment reference is required" });

            const expense = await db.expense.findOneAndUpdate(
                { _id, approvalStatus: "Approved", paymentStatus: "Unpaid" },
                {
                    $set: {
                        paymentStatus: "Paid",
                        processDate: processDate || new Date(),
                        paymentMethod: String(paymentMethod).trim(),
                        paymentReference: String(paymentReference || "").trim(),
                        handler: actorName(user),
                    },
                },
                { new: true, runValidators: true },
            );
            if (!expense)
                return callback({ status: "error", message: "Only approved, unpaid expenses may be paid" });
            callback({ status: "success", message: "Expense marked as paid", payload: expense });
        } catch (error) {
            callback({ status: "error", message: readableError(error) });
        }
    });
};
