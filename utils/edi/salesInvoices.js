const db = require('../../models');
const { getClient } = require('./client');
const { getConfiguredDropbox } = require('../documentStorage');
const { createInvoiceFlow } = require('./invoiceFlow');

module.exports = createInvoiceFlow({ db, getClient, getDropbox: getConfiguredDropbox });
