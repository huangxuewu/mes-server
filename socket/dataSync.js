const database = require('../config/database');
const dayjs = require('../utils/dayjs');
const { io } = require('./io');
const { createDataSync } = require('../utils/dataSync');

module.exports = createDataSync({
    connection: database.connection,
    getBusinessContext: async () => ({ businessDate: await dayjs.businessDate(), timeZone: await dayjs.getFactoryTimeZone() }),
    notify: () => io.to('data-sync-v1').emit('sync:changed'),
});
