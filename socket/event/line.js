const db = require("../../models");
const mongoose = require("mongoose");
const { getActiveSessionUser, hasPermission } = require('../session');

module.exports = (socket, io) => {
    socket.on('line:create', async (data, callback) => {
        try {

        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    })

    socket.on('line:update', async (payload, callback) => {
        try {
            const user = await getActiveSessionUser(socket);
            if (!hasPermission(user, 'update', 'production.run')) throw Error('productionRun.errors.permission');
            const { _id, status, productionRevision, ...data } = payload;
            for (const key of Object.keys(data)) {
                if (key.startsWith('status.') || key.startsWith('productionRevision.')) delete data[key];
            }

            data.steps?.forEach(step => {
                if (step.mainWorkers !== undefined || step.backupWorkers !== undefined) {
                    const main = step.mainWorkers ?? step.qualifiedWorkers ?? [];
                    const backup = step.backupWorkers ?? [];
                    if (!Array.isArray(main) || !Array.isArray(backup)) throw Error('productionStart.invalidWorkers');
                    const ids = [...main, ...backup].map(String);
                    if (new Set(ids).size !== ids.length) throw Error('productionStart.invalidWorkers');
                    step.mainWorkers = main;
                    step.backupWorkers = backup;
                    // Keep legacy roster consumers counting main positions only.
                    step.qualifiedWorkers = main;
                }
                ['documents', 'machines', 'tools', 'qualifiedWorkers', 'mainWorkers', 'backupWorkers'].forEach(field => {
                    if (Array.isArray(step[field])) {
                        step[field] = step[field].map(id => new mongoose.Types.ObjectId(`${id}`));
                    }
                })
            });

            const line = await db.line.findByIdAndUpdate(_id, { $set: data }, { new: true });
            if (!line) throw Error('productionStart.stepsSaveFailed');
            callback({ status: "success", message: "Line updated successfully", payload: line })

        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    })

    socket.on('line:delete', async (data, callback) => {
        try {

        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    })

    socket.on('line:get', async (query, callback) => {
        try {

        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    })

    socket.on('lines:get', async (query, callback) => {
        try {
            db.line.find(query).then(lines => {
                callback({ status: "success", message: "Lines fetched successfully", payload: lines })
            }).catch(error => {
                callback({ status: "error", message: error.message })
            })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    })

    socket.on('parameter:create', async (data, callback) => {
        try {
            const parameter = await db.parameter.create(data);
            callback({ status: "success", message: "Parameter created successfully", payload: parameter })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    })

    socket.on('parameter:update', async (data, callback) => {
        try {
            const parameter = await db.parameter.updateOne({ _id: data._id }, { $set: data });
            callback({ status: "success", message: "Parameter updated successfully", payload: parameter })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    })

    socket.on('parameter:delete', async (data, callback) => {
        try {
            const parameter = await db.parameter.deleteOne({ _id: data._id });
            callback({ status: "success", message: "Parameter deleted successfully", payload: parameter })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    })

    socket.on('parameter:get', async (data, callback) => {
        try {
            const parameter = await db.parameter.findOne({ _id: data._id });
            callback({ status: "success", message: "Parameter fetched successfully", payload: parameter })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    })

    socket.on('parameters:get', async (data = {}, callback) => {
        try {
            const parameter = await db.parameter.find(data);
            callback({ status: "success", message: "Parameter fetched successfully", payload: parameter })
        } catch (error) {
            callback({ status: "error", message: error.message })
        }
    })
}
