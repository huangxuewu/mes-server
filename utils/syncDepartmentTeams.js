const db = require("../models");

const syncDepartmentTeams = async (department) => {
    if (!department?._id) return;

    const memberMap = new Map();

    for (const team of department.teams || []) {
        if (!team?._id) continue;
        for (const memberId of team.members || [])
            memberMap.set(String(memberId), team._id);
    }

    const memberIds = [...memberMap.keys()];

    if (memberIds.length) {
        await Promise.all(memberIds.map(memberId =>
            db.employee.updateOne(
                { _id: memberId },
                { $set: { department: department._id, team: memberMap.get(memberId) } }
            )
        ));
    }

    const clearFilter = memberIds.length
        ? { department: department._id, _id: { $nin: memberIds } }
        : { department: department._id };

    await db.employee.updateMany(clearFilter, { $unset: { team: '', department: '' } });
};

module.exports = syncDepartmentTeams;
