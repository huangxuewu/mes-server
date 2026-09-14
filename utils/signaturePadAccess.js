const { createHash, randomBytes, randomUUID } = require('node:crypto');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const { hasPermission } = require('../socket/session');
const { buildOutboundBol, outboundBolSourceRevision } = require('./buildOutboundBol');

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
    const gateDetails = async (raw, loadNumber, session) => {
        if (raw.driver_signature || !loadNumber || (String(raw.trailer || '').trim() && String(raw.seal_number || '').trim())) return {};
        let query = models.hauler.findOne({ loadNumber, status: { $ne: 'Cancelled' } }).sort({ arrivedAt: -1, createdAt: -1, _id: -1 });
        if (session) query = query.session(session);
        const truck = await query.lean();
        const details = {};
        if (!String(raw.trailer || '').trim() && String(truck?.trailer || '').trim()) details.trailer = String(truck.trailer).trim();
        if (!String(raw.seal_number || '').trim() && String(truck?.seal || '').trim()) details.seal_number = String(truck.seal).trim();
        return details;
    };
    const authenticate = async token => {
        if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('signaturePad.deviceUnauthorized');
        const device = await models.signaturePadDevice.findOne({ tokenHash: hash(token), revoked: false }).lean();
        if (!device || !allowed(await getUser(device.ownerId))) throw new Error('signaturePad.deviceUnauthorized');
        return device;
    };
    const findTargets = async (number, session) => {
        let documentQuery = models.bolDocument.find({ $or: [{ number }, { 'rawData.bill_of_lading_number': number }] });
        if (session) documentQuery = documentQuery.session(session);
        const documents = await documentQuery.lean();
        const byId = new Map(documents.map(document => [String(document._id), document]));
        let query = models.outbound.find({ 'loads.bolId': { $in: documents.map(document => document._id) } },
            { loads: 1, poNumber: 1, name: 1, address: 1, city: 1, state: 1, zip: 1 });
        if (session) query = query.session(session);
        const records = await query.lean();
        const targets = records.flatMap(record => (record.loads || []).filter(load => byId.has(String(load.bolId)))
            .map(load => ({ record, load, bolDocument: byId.get(String(load.bolId)), outboundId: String(record._id), shipmentId: load.shipmentId,
                loadNumber: load.loadNumber, status: load.status, raw: byId.get(String(load.bolId)).rawData, number: byId.get(String(load.bolId)).number })));
        if (!targets.length) throw new Error('signaturePad.bolNotFound');
        if (targets.some(target => target.number !== number || !target.shipmentId || !target.loadNumber)) throw new Error('signaturePad.bolNotReady');
        if (new Set(targets.map(target => target.loadNumber)).size !== 1 || new Set(targets.map(target => `${target.outboundId}:${target.shipmentId}`)).size !== targets.length) throw new Error('signaturePad.ambiguousBol');
        return targets;
    };
    const findBol = async (number, session) => {
        const targets = await findTargets(number, session);
        if (targets.every(target => !target.raw)) throw new Error('signaturePad.bolNotFound');
        if (targets.some(target => !target.raw || target.raw.bill_of_lading_number !== number)) throw new Error('signaturePad.bolNotReady');
        if (targets.some(target => !target.raw.driver_signature && target.raw.signature_pad_source_revision
            && target.raw.signature_pad_source_revision !== outboundBolSourceRevision(targets))) throw new Error('signaturePad.bolChanged');
        const drafts = targets.map(target => {
            const draft = { ...target.raw };
            for (const field of ['driver_signature', 'driver_signature_date', 'driver_signature_submission_id', 'driver_signature_device_id']) delete draft[field];
            return JSON.stringify(draft);
        });
        if (new Set(drafts).size !== 1) throw new Error('signaturePad.ambiguousBol');
        const revision = hash(JSON.stringify(targets.map((target, index) => [target.outboundId, target.shipmentId, target.loadNumber, hash(drafts[index])]).sort((a, b) => a.join(':').localeCompare(b.join(':')))));
        const dualRevision = hash(JSON.stringify(targets.map((target, index) => {
            const draft = JSON.parse(drafts[index]);
            for (const field of ['shipper_signature', 'shipper_signature_date', 'shipper_signature_submission_id', 'shipper_signature_device_id']) delete draft[field];
            return [target.outboundId, target.shipmentId, target.loadNumber, hash(JSON.stringify(draft))];
        }).sort((a, b) => a.join(':').localeCompare(b.join(':')))));
        const printRevision = hash(JSON.stringify(targets.map(target => [target.outboundId, target.shipmentId, target.raw])
            .sort((a, b) => `${a[0]}:${a[1]}`.localeCompare(`${b[0]}:${b[1]}`))));
        return { targets, revision, dualRevision, printRevision };
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
        async lookup(device, barcode, allowSigned = false, allowCreate = false) {
            const number = normalizeBolBarcode(barcode);
            if (allowCreate) {
                const targets = await findTargets(number);
                if (targets.every(target => !target.raw)) {
                    buildOutboundBol(targets, number);
                    return { needsGeneration: true, bolNumber: number, loadNumber: targets[0].loadNumber };
                }
            }
            let { targets, revision, dualRevision, printRevision } = await findBol(number);
            if (!targets.some(target => target.raw.driver_signature || ['Completed', 'Cancelled'].includes(target.status))
                && Object.keys(await gateDetails(targets[0].raw, targets[0].loadNumber)).length) {
                const session = await models.outbound.startSession();
                try {
                    await session.withTransaction(async () => {
                        const fresh = await findBol(number, session);
                        if (fresh.targets.some(target => target.raw.driver_signature || ['Completed', 'Cancelled'].includes(target.status))) return;
                        const details = await gateDetails(fresh.targets[0].raw, fresh.targets[0].loadNumber, session);
                        if (!Object.keys(details).length) return;
                        const fields = Object.fromEntries(Object.entries(details).map(([key, value]) => [`rawData.${key}`, value]));
                        const updated = await models.bolDocument.updateOne({ _id: fresh.targets[0].bolDocument._id },
                            { $set: fields, $inc: { revision: 1 } }, { session });
                        if (updated.matchedCount !== 1) throw new Error('signaturePad.bolChanged');
                    });
                } finally { await session.endSession(); }
                ({ targets, revision, dualRevision, printRevision } = await findBol(number));
            }
            const signed = targets.some(target => target.raw.driver_signature);
            if (signed && targets.some(target => target.raw.signature_pad_requires_shipper && !target.raw.shipper_signature)) throw new Error('signaturePad.bolNotReady');
            if (signed && !allowSigned) throw new Error('signaturePad.alreadySigned');
            if (signed && targets.some(target => !target.raw.driver_signature || target.raw.driver_signature !== targets[0].raw.driver_signature
                || target.raw.driver_signature_date !== targets[0].raw.driver_signature_date
                || target.raw.shipper_signature !== targets[0].raw.shipper_signature
                || target.raw.shipper_signature_date !== targets[0].raw.shipper_signature_date)) throw new Error('signaturePad.ambiguousBol');
            if (!signed && targets.some(target => target.status === 'Completed')) throw new Error('signaturePad.bolCompleted');
            if (!signed && targets.some(target => target.status === 'Cancelled')) throw new Error('signaturePad.bolNotReady');
            const raw = targets[0].raw;
            const requiresShipper = !!raw.signature_pad_requires_shipper && !raw.shipper_signature;
            const documentId = randomUUID();
            const grant = jwt.sign({ kind: signed ? 'signature-pad-print' : 'signature-pad-bol', deviceId: device._id, number,
                revision: signed ? printRevision : requiresShipper ? dualRevision : revision, requiresShipper, documentId }, secret, { expiresIn: '30m', algorithm: 'HS256' });
            return { documentId, grant, signed, requiresShipper, bolNumber: number, loadNumber: targets[0].loadNumber,
                trailerNumber: String(raw.trailer || '').trim(),
                carrierName: String(raw.carrier_name || ''), shipTo: String(raw.ship_to?.name || ''), copies: targets.length };
        },
        async prepare(device, input) {
            const number = normalizeBolBarcode(input?.barcode);
            const session = await models.outbound.startSession();
            try {
                await session.withTransaction(async () => {
                    const targets = await findTargets(number, session);
                    if (targets.some(target => target.raw)) {
                        await findBol(number, session);
                        return;
                    }
                    const raw = buildOutboundBol(targets, number);
                    Object.assign(raw, await gateDetails(raw, targets[0].loadNumber, session));
                    const updated = await models.bolDocument.updateOne({ _id: targets[0].bolDocument._id },
                        { $set: { rawData: raw }, $inc: { revision: 1 } }, { session });
                    if (updated.matchedCount !== 1) throw new Error('signaturePad.bolChanged');
                });
            } finally { await session.endSession(); }
            return this.lookup(device, input.barcode, true);
        },
        async printData(user, input) {
            if (!allowed(user)) throw new Error('signaturePad.deviceUnauthorized');
            let grant;
            try { grant = jwt.verify(input?.grant, secret, { algorithms: ['HS256'] }); }
            catch { throw new Error('signaturePad.scanExpired'); }
            if (!['signature-pad-bol', 'signature-pad-print'].includes(grant.kind) || grant.deviceId !== input.deviceId) throw new Error('signaturePad.deviceUnauthorized');
            const device = await models.signaturePadDevice.findOne({ _id: input.deviceId, revoked: false }).lean();
            if (!device || !allowed(await getUser(device.ownerId))) throw new Error('signaturePad.deviceUnauthorized');
            const { targets, revision, dualRevision, printRevision } = await findBol(grant.number);
            if (grant.kind === 'signature-pad-print') {
                if (printRevision !== grant.revision || targets.some(target => !target.raw.driver_signature)) throw new Error('signaturePad.bolChanged');
                return { documentId: grant.documentId, bol: targets[0].raw };
            }
            if ((grant.requiresShipper ? dualRevision : revision) !== grant.revision || targets.some(target => !target.raw.driver_signature
                || target.raw.driver_signature !== targets[0].raw.driver_signature || target.raw.driver_signature_date !== targets[0].raw.driver_signature_date
                || target.raw.driver_signature_submission_id !== input.submissionId || target.raw.driver_signature_device_id !== input.deviceId
                || (grant.requiresShipper && (!target.raw.shipper_signature || target.raw.shipper_signature !== targets[0].raw.shipper_signature
                    || target.raw.shipper_signature_date !== targets[0].raw.shipper_signature_date
                    || target.raw.shipper_signature_submission_id !== input.submissionId || target.raw.shipper_signature_device_id !== input.deviceId)))) throw new Error('signaturePad.bolChanged');
            return { documentId: grant.documentId, bol: targets[0].raw };
        },
        async sign(device, input) {
            let grant;
            try { grant = jwt.verify(input?.grant, secret, { algorithms: ['HS256'] }); }
            catch { throw new Error('signaturePad.scanExpired'); }
            if (grant.kind !== 'signature-pad-bol' || grant.deviceId !== device._id) throw new Error('signaturePad.deviceUnauthorized');
            if (typeof input.submissionId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.submissionId)) throw new Error('signaturePad.invalidMessage');
            const image = input.image;
            for (const image of [input.image, ...(input.shipperImage !== undefined ? [input.shipperImage] : [])]) {
                if (typeof image !== 'string' || image.length > 256 * 1024 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) throw new Error('signaturePad.invalidImage');
                try {
                    const buffer = Buffer.from(image.slice(22), 'base64');
                    const decoder = sharp(buffer, { limitInputPixels: 4096 * 4096 });
                    const metadata = await decoder.metadata();
                    if (metadata.format !== 'png' || metadata.width > 4096 || metadata.height > 4096) throw new Error();
                    await decoder.raw().toBuffer();
                } catch { throw new Error('signaturePad.invalidImage'); }
            }
            const session = await models.outbound.startSession();
            let savedAt;
            try {
                await session.withTransaction(async () => {
                    const { targets, revision, dualRevision } = await findBol(grant.number, session);
                    const requiresShipper = grant.requiresShipper === true;
                    if ((requiresShipper ? dualRevision : revision) !== grant.revision) throw new Error('signaturePad.bolChanged');
                    if (targets[0].raw.signature_pad_requires_shipper && !targets[0].raw.shipper_signature && !requiresShipper) throw new Error('signaturePad.shipperRequired');
                    if (requiresShipper && !input.shipperImage) throw new Error('signaturePad.shipperRequired');
                    if (!requiresShipper && input.shipperImage !== undefined) throw new Error('signaturePad.invalidMessage');
                    const previous = targets.filter(target => target.raw.driver_signature);
                    if (previous.length) {
                        if (previous.length !== targets.length || previous.some(target => target.raw.driver_signature_submission_id !== input.submissionId || target.raw.driver_signature_device_id !== device._id || target.raw.driver_signature !== image
                            || (requiresShipper && target.raw.shipper_signature !== input.shipperImage))) throw new Error('signaturePad.alreadySigned');
                        savedAt = previous[0].raw.driver_signature_date;
                        return;
                    }
                    if (requiresShipper && targets.some(target => target.raw.shipper_signature)) throw new Error('signaturePad.bolChanged');
                    if (targets.some(target => target.status === 'Completed')) throw new Error('signaturePad.bolCompleted');
                    if (targets.some(target => target.status === 'Cancelled')) throw new Error('signaturePad.bolNotReady');
                    savedAt = new Date().toISOString();
                    const updated = await models.bolDocument.updateOne({ _id: targets[0].bolDocument._id },
                        { $set: { 'rawData.driver_signature': image, 'rawData.driver_signature_date': savedAt,
                            'rawData.driver_signature_submission_id': input.submissionId, 'rawData.driver_signature_device_id': device._id,
                            ...(requiresShipper ? { 'rawData.shipper_signature': input.shipperImage, 'rawData.shipper_signature_date': savedAt,
                                'rawData.shipper_signature_submission_id': input.submissionId, 'rawData.shipper_signature_device_id': device._id } : {}) },
                            $inc: { revision: 1 } }, { session });
                    if (updated.matchedCount !== 1) throw new Error('signaturePad.bolChanged');
                });
            } finally { await session.endSession(); }
            return { documentId: grant.documentId, submissionId: input.submissionId, savedAt };
        },
    };
};

module.exports = { createSignaturePadAccess, normalizeBolBarcode };
