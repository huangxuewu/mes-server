const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const clone = value => value == null ? value : structuredClone(value);
const at = (row, key) => key.split('.').reduce((value, part) => Array.isArray(value) && !/^\d+$/.test(part) ? value.map(item => item?.[part]) : value?.[part], row);
const equal = (left, right) => left instanceof Date || right instanceof Date ? Number(new Date(left)) === Number(new Date(right)) : String(left) === String(right);
const matches = (row, query) => Object.entries(query).every(([key, expected]) => {
    if (key === '$or') return expected.some(item => matches(row, item));
    if (key === '$and') return expected.every(item => matches(row, item));
    const actual = at(row, key);
    const values = Array.isArray(actual) ? actual : [actual];
    if (expected && typeof expected === 'object' && !(expected instanceof Date) && !Array.isArray(expected)) return Object.entries(expected).every(([operator, value]) => {
        if (operator === '$exists') return (actual !== undefined) === value;
        if (operator === '$regex') return values.some(item => typeof item === 'string' && new RegExp(value, expected.$options || '').test(item));
        if (operator === '$options') return true;
        if (operator === '$ne') return !values.some(item => equal(item, value));
        if (operator === '$in') return values.some(item => value.some(candidate => equal(item, candidate)));
        if (operator === '$nin') return !values.some(item => value.some(candidate => equal(item, candidate)));
        if (operator === '$lt') return actual < value;
        if (operator === '$lte') return actual <= value;
        if (operator === '$gt') return actual > value;
        if (operator === '$gte') return actual >= value;
        throw new Error(`Unsupported test query ${operator}`);
    });
    return values.some(value => equal(value, expected));
});
const set = (row, key, value, remove = false) => {
    const parts = key.split('.');
    const last = parts.pop();
    let target = row;
    for (const part of parts) target = target[part] ||= {};
    if (remove) delete target[last]; else target[last] = clone(value);
};
let sequence = 100;
class Collection {
    constructor(rows = [], defaults = {}) { this.rows = clone(rows); this.defaults = defaults; this.writes = []; this.failNextUpdate = false; }
    query(rows, single = false) {
        const query = { sort: order => { rows.sort((a, b) => { for (const [key, direction] of Object.entries(order)) { const left = at(a, key), right = at(b, key); if (left < right) return -direction; if (left > right) return direction; } return 0; }); return query; },
            limit: count => { rows = rows.slice(0, count); return query; }, lean: async () => clone(single ? rows[0] || null : rows),
            then: (resolve, reject) => query.lean().then(resolve, reject) };
        return query;
    }
    find(query = {}) { return this.query(this.rows.filter(row => matches(row, query))); }
    findOne(query = {}) { return this.query(this.rows.filter(row => matches(row, query)), true); }
    findById(id) { return this.findOne({ _id: id }); }
    async countDocuments(query) { return this.rows.filter(row => matches(row, query)).length; }
    async exists(query) { return !!this.rows.find(row => matches(row, query)); }
    update(query, change, options = {}) {
        if (this.failNextUpdate) { this.failNextUpdate = false; throw new Error('Simulated database failure'); }
        let row = this.rows.find(row => matches(row, query));
        let inserted = false;
        if (!row && options.upsert) {
            row = { _id: (++sequence).toString(16).padStart(24, '0'), createdAt: new Date(), ...clone(this.defaults) };
            for (const [key, value] of Object.entries(query)) if (!key.startsWith('$') && (typeof value !== 'object' || value instanceof Date)) row[key] = clone(value);
            this.rows.push(row); inserted = true;
        }
        if (!row) return null;
        this.writes.push({ query: clone(query), change: clone(change) });
        for (const [operator, values] of Object.entries(change)) for (const [key, value] of Object.entries(values)) {
            if (operator === '$set' || (operator === '$setOnInsert' && inserted)) set(row, key, value);
            if (operator === '$unset') set(row, key, null, true);
            if (operator === '$inc') set(row, key, (at(row, key) || 0) + value);
            if (operator === '$push') set(row, key, [...(at(row, key) || []), value]);
            if (operator === '$addToSet') set(row, key, [...new Set([...(at(row, key) || []), value])]);
            if (operator === '$pull') set(row, key, (at(row, key) || []).filter(item => !equal(item, value)));
        }
        return row;
    }
    findOneAndUpdate(query, change, options) { const row = this.update(query, change, options); return this.query(row ? [row] : [], true); }
    async updateOne(query, change, options) { const row = this.update(query, change, options); return { matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0 }; }
    async updateMany(query, change) { const rows = this.rows.filter(row => matches(row, query)); for (const row of rows) this.update({ _id: row._id }, change); return { matchedCount: rows.length }; }
    async create(data) { const row = { _id: (++sequence).toString(16).padStart(24, '0'), ...clone(this.defaults), ...clone(data), createdAt: new Date() }; this.rows.push(row); this.writes.push({ create: clone(data) }); return clone(row); }
    async deleteOne(query) { const index = this.rows.findIndex(row => matches(row, query)); if (index >= 0) this.rows.splice(index, 1); this.writes.push({ delete: clone(query) }); }
}
const ids = { a: 'aaaaaaaaaaaaaaaaaaaaaaaa', b: 'bbbbbbbbbbbbbbbbbbbbbbbb', outsider: 'cccccccccccccccccccccccc', topic: 'dddddddddddddddddddddddd' };
const fixture = () => {
    const db = { user: new Collection(Object.entries(ids).filter(([key]) => key !== 'topic').map(([key, _id]) => ({ _id, displayName: key, role: 'User', status: 'Active' }))),
        topic: new Collection([{ _id: ids.topic, creator: ids.a, editors: [ids.a], participants: [ids.a, ids.b], pinned: [], archived: [], revision: 0, title: 'Inspection', description: 'Guard inspection', createdAt: new Date('2026-01-01') }], { revision: 0, pinned: [], archived: [], isDeleted: false }),
        message: new Collection([], { status: 'Active', revision: 0, attachments: [], history: [] }), messageRead: new Collection(),
        messageAttachment: new Collection([], { status: 'Staged', offset: 0 }) };
    const io = { sockets: { sockets: new Map() } };
    const sessions = { getSessionUserId: socket => socket.data.userId, getActiveSessionUser: async socket => {
        const user = await db.user.findById(socket.data.userId).lean();
        if (!user || user.status !== 'Active' || socket.data.expiresAt <= Date.now()) throw new Error('Sign in to continue');
        return user;
    } };
    const files = new Map(), uploadSessions = new Map(), storageCalls = [];
    const dropbox = {
        filesCreateFolderV2: async () => ({}),
        filesUploadSessionStart: async () => { const session_id = crypto.randomUUID(); uploadSessions.set(session_id, Buffer.alloc(0)); return { result: { session_id } }; },
        filesUploadSessionAppendV2: async ({ cursor, contents }) => {
            storageCalls.push('append'); const buffer = uploadSessions.get(cursor.session_id);
            if (!buffer) throw new Error('Session closed');
            if (buffer.length !== cursor.offset) throw { error: { error: { correct_offset: buffer.length } } };
            uploadSessions.set(cursor.session_id, Buffer.concat([buffer, contents]));
        },
        filesUploadSessionFinish: async ({ cursor, commit }) => { storageCalls.push('finish'); const bytes = uploadSessions.get(cursor.session_id); if (!bytes) throw new Error('Session closed'); files.set(commit.path, bytes); uploadSessions.delete(cursor.session_id); return { result: { size: bytes.length } }; },
        filesGetMetadata: async ({ path }) => { if (!files.has(path)) throw new Error('File missing'); return { result: { size: files.get(path).length } }; },
        filesDeleteV2: async ({ path }) => { files.delete(path); return {}; },
        filesGetTemporaryLink: async () => ({ result: { link: 'https://download.example.test/private-file' } }),
    };
    const load = (relative, extra = {}) => {
        const filename = path.join(__dirname, '../..', relative);
        const module = { exports: {} };
        vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, Buffer, ArrayBuffer, Date, console, process,
            require: name => {
                if (name.endsWith('/models')) return db;
                if (name.endsWith('/session') || name === './session') return sessions;
                if (name.endsWith('/messageDelivery')) return load('socket/messageDelivery.js');
                if (name.endsWith('/documentStorage')) return { getDropbox: () => dropbox, normalizePathPart: value => value.replace(/[^a-z\d.]/gi, '-') };
                if (name in extra) return extra[name];
                return require(name.startsWith('.') ? path.resolve(path.dirname(filename), name) : name);
            } }, { filename });
        return module.exports;
    };
    const connect = userId => {
        const handlers = new Map(), received = [];
        const socket = { data: { userId, sessionGeneration: 1, expiresAt: Date.now() + 3600000 },
            on: (event, handler) => handlers.set(event, handler), emit: (event, payload) => received.push({ event, payload }) };
        io.sockets.sockets.set(crypto.randomUUID(), socket);
        load('socket/event/message.js')(socket, io);
        load('socket/event/messageAttachment.js')(socket, io);
        return { socket, received, call: (event, input) => new Promise(resolve => handlers.get(event)(input, resolve)) };
    };
    return { db, io, connect, load, files, storageCalls, ids, dropbox };
};
module.exports = { fixture, Collection, ids };
