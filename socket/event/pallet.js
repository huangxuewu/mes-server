const db = require("../../models");
const dayjs = require("../../utils/dayjs");

module.exports = (socket, io) => {

    socket.on("pallet:rate10m", async (query, callback) => {
        try {
            const date = query?.date;
            const styleCode = query?.styleCode;
            const windowMinutes = Math.max(10, Number(query?.windowMinutes) || 240);
            const bucketMinutes = Math.max(1, Number(query?.bucketMinutes) || 10);

            if (!date || !styleCode)
                return callback({ status: "error", message: "Missing date or styleCode" });

            const bucketCount = Math.ceil(windowMinutes / bucketMinutes);
            const now = dayjs();
            const alignedNow = now
                .startOf("minute")
                .minute(Math.floor(now.minute() / bucketMinutes) * bucketMinutes)
                .second(0)
                .millisecond(0);

            const start = alignedNow.subtract((bucketCount - 1) * bucketMinutes, "minute");
            const end = alignedNow.add(bucketMinutes, "minute");

            const records = await db.pallet.find(
                {
                    date,
                    styleCode,
                    printedAt: { $gte: start.toDate(), $lt: end.toDate() }
                },
                { printedAt: 1 }
            ).lean();

            const buckets = Array.from({ length: bucketCount }, (_v, index) => {
                const bucketStart = start.add(index * bucketMinutes, "minute");

                return {
                    bucketStart: bucketStart.toISOString(),
                    bucketLabel: bucketStart.format("HH:mm"),
                    count: 0
                };
            });

            const bucketIndexByStart = new Map(buckets.map((bucket, index) => [bucket.bucketStart, index]));

            for (const record of records) {
                if (!record?.printedAt) continue;

                const printedAt = dayjs(record.printedAt)
                    .startOf("minute")
                    .minute(Math.floor(dayjs(record.printedAt).minute() / bucketMinutes) * bucketMinutes)
                    .second(0)
                    .millisecond(0)
                    .toISOString();

                const index = bucketIndexByStart.get(printedAt);
                if (index === undefined) continue;
                buckets[index].count += 1;
            }

            callback({
                status: "success",
                message: "Pallet production rate fetched successfully",
                payload: {
                    date,
                    styleCode,
                    bucketMinutes,
                    windowMinutes,
                    buckets
                }
            });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("pallet:reserve", async (data, callback) => {
        try {
            const date = data?.date;
            const styleCode = data?.styleCode;
            const lotNumber = data?.lotNumber;

            if (!date || !styleCode || !lotNumber)
                return callback({ status: "error", message: "Missing date, styleCode, or lotNumber" });

            const counterId = `pallet:${date}:${styleCode}`;
            const counter = await db.counter.findByIdAndUpdate(
                counterId,
                { $inc: { sequence: 1 } },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );

            const madeCount = counter?.sequence || 1;
            const palletId = `${lotNumber}-${String(madeCount).padStart(3, '0')}`;

            callback({ status: "success", message: "Pallet serial reserved successfully", payload: { madeCount, palletId } });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("pallet:create", async (data, callback) => {
        try {
            const pallet = await db.pallet.create(data);
            callback({ status: "success", message: "Pallet created successfully", payload: pallet });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("pallet:update", async (data, callback) => {
        try {
            const pallet = await db.pallet.findByIdAndUpdate(data._id, data, { new: true });
            callback({ status: "success", message: "Pallet updated successfully", payload: pallet });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("pallet:delete", async (data, callback) => {
        try {
            await db.pallet.findByIdAndDelete(data._id);
            callback({ status: "success", message: "Pallet deleted successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("pallet:get", async (data, callback) => {
        try {
            const pallet = await db.pallet.findById(data._id);
            callback({ status: "success", message: "Pallet fetched successfully", payload: pallet });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("pallets:get", async (query = {}, callback) => {
        try {
            const pallets = await db.pallet.find(query).sort({ printedAt: 1 });
            callback({ status: "success", message: "Pallets fetched successfully", payload: pallets });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

    socket.on("pallet:count", async (query, callback) => {
        try {
            const count = await db.pallet.countDocuments(query);
            callback({ status: "success", message: "Pallet count fetched successfully", payload: count });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    });

};