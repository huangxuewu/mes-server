const carrierNames = require('../config/bolCarrierNames.json');
const { createHash, randomUUID } = require('node:crypto');

const outboundBolSourceRevision = targets => createHash('sha256').update(JSON.stringify(targets.map(({ record, load, bolDocument }) => [
    String(record._id), load.shipmentId, load.loadNumber, bolDocument?.number,
    ...['poNumber', 'name', 'address', 'city', 'state', 'zip'].map(key => record[key] ?? ''),
    ...['assignedSCAC', 'executingSCAC', 'carrierSCAC', 'proNumber', 'chRobinsonNumber', 'cartons', 'weight', 'pallets'].map(key => load[key] ?? ''),
]).sort((a, b) => `${a[0]}:${a[1]}`.localeCompare(`${b[0]}:${b[1]}`)))).digest('hex');

// Keep the form fields and shipping rules aligned with the MES BOL editor.
const buildOutboundBol = (targets, number, now = new Date()) => {
    const { record, load } = targets[0];
    const scac = String(load.assignedSCAC || '').trim();
    const consolidation = scac === 'SCII';
    const ltl = (!!load.executingSCAC && load.executingSCAC !== scac) || carrierNames[scac] === 'CH Robinson';
    for (const target of targets) {
        if (target.load.status === 'Completed') throw new Error('signaturePad.bolCompleted');
        if (target.load.status === 'Cancelled' || String(target.load.carrierSCAC || target.load.executingSCAC || target.load.assignedSCAC || '').toUpperCase().trim() === 'DMSP'
            || target.bolDocument?.url || !target.record.poNumber || !target.load.assignedSCAC
            || !Number.isFinite(target.load.cartons) || target.load.cartons <= 0
            || !Number.isFinite(target.load.weight) || target.load.weight <= 0
            || (target.load.pallets != null && (!Number.isFinite(target.load.pallets) || target.load.pallets < 0))) throw new Error('signaturePad.bolNotReady');
        if (!consolidation && ['name', 'address', 'city', 'state', 'zip'].some(key => !target.record[key])) throw new Error('signaturePad.bolNotReady');
        if (['assignedSCAC', 'executingSCAC', 'proNumber', 'chRobinsonNumber'].some(key => (target.load[key] || '') !== (load[key] || ''))
            || (!consolidation && ['name', 'address', 'city', 'state', 'zip'].some(key => target.record[key] !== record[key]))) throw new Error('signaturePad.ambiguousBol');
    }
    const cartons = targets.reduce((total, target) => total + target.load.cartons, 0);
    const weight = targets.reduce((total, target) => total + target.load.weight, 0);
    const pallets = targets.reduce((total, target) => total + (target.load.pallets || 0), 0);
    const order = { customer_order_number: '', pkgs: '', weight: '', pallet_slip: '', plts: '', mabd: '', destination: '', po_type: '', department: '', additional_shipper_info: '', inspected: false, loaded: false };
    const commodity = { handling_unit_qty: '', handling_unit_type: '', package_qty: '', package_type: '', weight: '', hm: '', commodity_description: '', ltl_only_nmfc: '', ltl_only_class: '' };
    const orders = [...targets].sort((a, b) => b.load.cartons - a.load.cartons).map(target => ({ ...order,
        customer_order_number: `062-${target.record.poNumber}`, pkgs: target.load.cartons, weight: target.load.weight,
        plts: target.load.pallets ?? '', pallet_slip: ltl ? 'Y' : 'N' }));
    while (orders.length < 10) orders.push({ ...order });
    return {
        title: 'Bill of Lading', date: now.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', year: 'numeric' }), page: 1, pages: 1,
        ship_from: { name: 'Down Home Manufacturing LLC', address: '402 Maxwell Ave', city: 'Greenwood', state: 'SC', zip: '29646', sid: '', fob: false },
        ship_to: consolidation ? { name: 'TARGET C/O Southeast Consolidators', address: '2590 Campbell Blvd', city: 'Ellenwood', state: 'GA', zip: '30294' }
            : { name: record.name, address: record.address, city: record.city, state: record.state, zip: record.zip, cid: '', location: '', fob: false },
        bill_to: ltl ? { name: 'TARGET CORP C/O CHRLTL', address: '14701 CHARLSON RD STE 2100', city: 'EDEN PRAIRIE', state: 'MN', zip: '55347' }
            : { name: '', address: '', city: '', state: '', zip: '' },
        load_number: load.loadNumber, ch_robinson_number: load.chRobinsonNumber || '', special_instructions: '', bill_of_lading_number: number,
        carrier_name: carrierNames[scac] || scac, trailer: '', seal_number: '', scac, pro: load.proNumber || '',
        freight_charge_terms: ltl ? 'third_party' : 'collect', is_master_bol: false, customer_order_info: orders,
        commodity_info: [{ ...commodity, handling_unit_type: 'PLT', package_qty: cartons, package_type: 'CTN', weight, commodity_description: 'Pillows' }, ...Array.from({ length: 3 }, () => ({ ...commodity }))],
        grand_totals: { customer_order_info: { pkgs: cartons, plts: pallets, weight }, commodity_info: { handling_unit_qty: pallets, package_qty: cartons, weight } },
        cod_amount: '', fee_terms: '', customer_check_acceptable: false,
        trailer_loaded_by_shipper: false, trailer_loaded_by_driver: false, freight_counted_by_shipper: false, freight_counted_by_driver_pallets: false, freight_counted_by_driver_pieces: false,
        shipper_signature_date: '', shipper_signature: '', driver_signature_date: '', driver_signature: '',
        trailer_loaded: { by_shipper: true, by_driver: false }, freight_counted: { by_shipper: true, by_driver_pallets: false, by_driver_pieces: false },
        signature_pad_requires_shipper: true,
        signature_pad_document_id: randomUUID(),
        signature_pad_source_revision: outboundBolSourceRevision(targets),
    };
};

module.exports = { buildOutboundBol, outboundBolSourceRevision };
