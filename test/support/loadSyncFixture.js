const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const mongoose = require('mongoose');
const dayjs = require('dayjs');
const { randomUUID } = require('node:crypto');

async function loadSyncFixture(uri, sources = {}) {
    if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\/data_sync_test_[a-z\d_]+(?:\?|$)/i.test(uri || ''))
        throw new Error('Load sync tests require a disposable localhost database');
    const connection = await mongoose.createConnection(uri, {
        dbName: `data_sync_test_load_${randomUUID().replaceAll('-', '')}`, monitorCommands: true,
    }).asPromise();
    const commands = [];
    connection.getClient().on('commandStarted', event => {
        if (['find', 'getMore', 'update', 'insert', 'aggregate', 'findAndModify'].includes(event.commandName))
            commands.push({ name: event.commandName, command: event.command });
    });
    const logs = [];
    const logger = Object.fromEntries(['log', 'info', 'warn', 'error'].map(level => [level, (...args) => logs.push({ level, args })]));
    const database = { model: (name, schema, collection) => {
        const model = connection.model(name, schema, collection);
        model.watch = () => new EventEmitter();
        return model;
    } };
    const evaluate = (file, dependencies) => {
        const module = { exports: {} };
        vm.runInNewContext(sources[file] || fs.readFileSync(path.join(__dirname, '../..', file), 'utf8'), {
            module, console: logger, Date, setTimeout, clearTimeout,
            require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name),
        });
        return module.exports;
    };
    const common = { mongoose, '../config/database': database,
        '../socket/io': { io: { except: () => ({ emit() {} }) } },
        '../utils/outboundScac': require('../../utils/outboundScac') };
    const db = { order: evaluate('models/order.js', common), outbound: evaluate('models/outbound.js', common) };
    await Promise.all(Object.values(db).map(model => model.init()));
    const handlers = {};
    evaluate('socket/event/shipment.js', { mongoose, '../../models': db, '../../utils/dayjs': dayjs,
        '../../utils/outboundScac': require('../../utils/outboundScac'),
        '../../utils/outboundOrder': {}, '../../utils/edi/asn': {} })(
        { on: (name, handler) => { handlers[name] = handler; } }, {});
    return { db, connection, commands, logs,
        sync: async payload => {
            let result;
            await handlers['load:sync'](payload, response => { result = response; });
            return result;
        },
        close: async () => { await connection.dropDatabase(); await connection.close(); },
    };
}

module.exports = { loadSyncFixture };
