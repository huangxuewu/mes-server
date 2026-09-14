const { createHash, randomBytes, randomUUID } = require('node:crypto');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const { hasPermission } = require('../socket/session');

const hash = value => createHash('sha256').update(value).digest('hex');
const allowed = user => user?.status === 'Active' && user.role !== 'System' && hasPermission(user, 'module', 'office');
const normalizeBolBarcode = barcode => {
    if (typeof barcode !== 'string' || barcode.length > 128) throw new Error('signaturePad.invalidBarcode');
    const value = barcode.trim().replace(/^\]C[01]/, '').replace(/[\s\x1d]/g, '');
    const match = value.match(/^(?:\(401\)|401)([a-zA-Z0-9-]{1,30})$/);
    if (!match) throw new Error('signaturePad.invalidBarcode');
    return match[1];
};

const createSignaturePadAccess = ({ models, secret, getUser }) => {
    const authenticate = async token => {
        if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('signaturePad.deviceUnauthorized');
        const device = await models.signaturePadDevice.findOne({ tokenHash: hash(token), revoked: false }).lean();
        if (!device || !allowed(await getUser(device.ownerId))) throw new Error('signaturePad.deviceUnauthorized');
        return device;
    };
    const findBol = async (number, session) => {
        let query = models.outbound.find({ $or: [{ 'loads.bol.number': number }, { 'loads.bol.rawData.bill_of_lading_number': number }] }, { loads: 1 });
        if (session) query = query.session(session);
        const records = await query.lean();
        const targets = records.flatMap(record => (record.loads || []).filter(load => load.bol?.number === number || load.bol?.rawData?.bill_of_lading_number === number)
            .map(load => ({ outboundId: String(record._id), shipmentId: load.shipmentId, loadNumber: load.loadNumber, status: load.status, raw: load.bol?.rawData, number: load.bol?.number })));
        if (!targets.length) throw new Error('signaturePad.bolNotFound');
        if (targets.some(target => !target.raw || target.number !== number || target.raw.bill_of_lading_number !== number || !target.shipmentId || !target.loadNumber)) throw new Error('signaturePad.bolNotReady');
        if (new Set(targets.map(target => target.loadNumber)).size !== 1 || new Set(targets.map(target => `${target.outboundId}:${target.shipmentId}`)).size !== targets.length) throw new Error('signaturePad.ambiguousBol');
        const drafts = targets.map(target => {
            const draft = { ...target.raw };
            for (const field of ['driver_signature', 'driver_signature_date', 'driver_signature_submission_id', 'driver_signature_device_id']) delete draft[field];
            return JSON.stringify(draft);
        });
        if (new Set(drafts).size !== 1) throw new Error('signaturePad.ambiguousBol');
        const revision = hash(JSON.stringify(targets.map((target, index) => [target.outboundId, target.shipmentId, target.loadNumber, hash(drafts[index])]).sort((a, b) => a.join(':').localeCompare(b.join(':')))));
        return { targets, revision };
    };
    return {
        authenticate,
        async authorize(user, deviceId) {
            if (!allowed(user)) throw new Error('signaturePad.deviceUnauthorized');
            if (typeof deviceId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(deviceId)) throw new Error('signaturePad.invalidDevice');
            const token = randomBytes(32).toString('hex');
            try {
                await models.signaturePadDevice.findOneAndUpdate({ _id: deviceId,
                    ...(user.role === 'Admin' ? {} : { $or: [{ ownerId: String(user._id) }, { revoked: true }] }) },
                    { $set: { ownerId: String(user._id), tokenHash: hash(token), revoked: false } }, { upsert: true });
            } catch (error) {
                if (error.code === 11000) throw new Error('signaturePad.deviceUnauthorized');
                throw error;
            }
            return { deviceId, token };
        },
        async revoke(user, deviceId) {
            if (!allowed(user)) throw new Error('signaturePad.deviceUnauthorized');
            await models.signaturePadDevice.updateOne({ _id: deviceId, ...(user.role === 'Admin' ? {} : { ownerId: String(user._id) }) }, { $set: { revoked: true } });
        },
        async lookup(device, barcode) {
            const number = normalizeBolBarcode(barcode);
            const { targets, revision } = await findBol(number);
            if (targets.some(target => target.raw.driver_signature)) throw new Error('signaturePad.alreadySigned');
            if (targets.some(target => target.status === 'Completed')) throw new Error('signaturePad.bolCompleted');
            const raw = targets[0].raw;
            const documentId = randomUUID();
            const grant = jwt.sign({ kind: 'signature-pad-bol', deviceId: device._id, number, revision, documentId }, secret, { expiresIn: '30m', algorithm: 'HS256' });
            return { documentId, grant, bolNumber: number, loadNumber: targets[0].loadNumber,
                carrierName: String(raw.carrier_name || ''), shipTo: String(raw.ship_to?.name || ''), copies: targets.length };
        },
        async printData(user, input) {
            if (!allowed(user)) throw new Error('signaturePad.deviceUnauthorized');
            let grant;
            try { grant = jwt.verify(input?.grant, secret, { algorithms: ['HS256'] }); }
            catch { throw new Error('signaturePad.scanExpired'); }
            if (grant.kind !== 'signature-pad-bol' || grant.deviceId !== input.deviceId) throw new Error('signaturePad.deviceUnauthorized');
            const device = await models.signaturePadDevice.findOne({ _id: input.deviceId, revoked: false }).lean();
            if (!device || !allowed(await getUser(device.ownerId))) throw new Error('signaturePad.deviceUnauthorized');
            const { targets, revision } = await findBol(grant.number);
            if (revision !== grant.revision || targets.some(target => !target.raw.driver_signature
                || target.raw.driver_signature !== targets[0].raw.driver_signature || target.raw.driver_signature_date !== targets[0].raw.driver_signature_date
                || target.raw.driver_signature_submission_id !== input.submissionId || target.raw.driver_signature_device_id !== input.deviceId)) throw new Error('signaturePad.bolChanged');
            return { documentId: grant.documentId, bol: targets[0].raw };
        },
        async sign(device, input) {
            let grant;
            try { grant = jwt.verify(input?.grant, secret, { algorithms: ['HS256'] }); }
            catch { throw new Error('signaturePad.scanExpired'); }
            if (grant.kind !== 'signature-pad-bol' || grant.deviceId !== device._id) throw new Error('signaturePad.deviceUnauthorized');
            if (typeof input.submissionId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.submissionId)) throw new Error('signaturePad.invalidMessage');
            const image = input.image;
            if (typeof image !== 'string' || image.length > 256 * 1024 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) throw new Error('signaturePad.invalidImage');
            try {
                const buffer = Buffer.from(image.slice(22), 'base64');
                const decoder = sharp(buffer, { limitInputPixels: 4096 * 4096 });
                const metadata = await decoder.metadata();
                if (metadata.format !== 'png' || metadata.width > 4096 || metadata.height > 4096) throw new Error();
                await decoder.raw().toBuffer();
            } catch { throw new Error('signaturePad.invalidImage'); }
            const session = await models.outbound.startSession();
            let savedAt;
            try {
                await session.withTransaction(async () => {
                    const { targets, revision } = await findBol(grant.number, session);
                    if (revision !== grant.revision) throw new Error('signaturePad.bolChanged');
                    const previous = targets.filter(target => target.raw.driver_signature);
                    if (previous.length) {
                        if (previous.length !== targets.length || previous.some(target => target.raw.driver_signature_submission_id !== input.submissionId || target.raw.driver_signature_device_id !== device._id || target.raw.driver_signature !== image)) throw new Error('signaturePad.alreadySigned');
                        savedAt = previous[0].raw.driver_signature_date;
                        return;
                    }
                    if (targets.some(target => target.status === 'Completed')) throw new Error('signaturePad.bolCompleted');
                    savedAt = new Date().toISOString();
                    for (const target of targets) {
                        const updated = await models.outbound.updateOne({ _id: target.outboundId, loads: { $elemMatch: { shipmentId: target.shipmentId, 'bol.number': grant.number } } },
                            { $set: { 'loads.$[target].bol.rawData.driver_signature': image, 'loads.$[target].bol.rawData.driver_signature_date': savedAt,
                                'loads.$[target].bol.rawData.driver_signature_submission_id': input.submissionId, 'loads.$[target].bol.rawData.driver_signature_device_id': device._id } },
                            { arrayFilters: [{ 'target.shipmentId': target.shipmentId, 'target.bol.number': grant.number }], session });
                        if (updated.matchedCount !== 1) throw new Error('signaturePad.bolChanged');
                    }
                });
            } finally { await session.endSession(); }
            return { documentId: grant.documentId, submissionId: input.submissionId, savedAt };
        },
    };
};

module.exports = { createSignaturePadAccess, normalizeBolBarcode };
