const db = require("../models");

const cleanupOrphanedTeamSchedules = async (department) => {
    if (!department?._id) return;

    const activeTeamIds = (department.teams || []).map(team => team._id).filter(Boolean);
    const filter = activeTeamIds.length
        ? { departmentId: department._id, teamId: { $nin: activeTeamIds } }
        : { departmentId: department._id };

    await db.workSchedule.deleteMany(filter);
};

const cleanupDepartmentSchedules = async (departmentId) => {
    if (!departmentId) return;

    await db.workSchedule.deleteMany({ departmentId });
};

module.exports = { cleanupOrphanedTeamSchedules, cleanupDepartmentSchedules };
