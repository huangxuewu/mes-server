(() => {
    'use strict';
    const base = '/addon/labelMaker/finishProduct/mobile/api';
    const lineId = new URLSearchParams(location.search).get('line') || '';
    const el = Object.fromEntries(['login-form','login-button','employee-pin','production-controls','employee-name','product-name','line-name','print-button','output-count','print-action','saved-pallet','next-pallet','refresh','sign-out','message','bluetooth-support','printer-selector','printer-name','lot-number','cases-button','cases-value','cases-dialog','cases-form','cases-input','cases-limit','cases-cancel'].map(id => [id, document.getElementById(id)]));
    const read = (storage, key) => { try { return JSON.parse(storage.getItem(key) || 'null'); } catch { return null; } };
    const sessionKey = `productionMobile:session:${lineId}`;
    let session = read(sessionStorage, sessionKey);
    let sessionVersion = 0;
    let context = null, boxes = null, busy = false, ready = false, refreshing = false;
    let work = read(localStorage, workKey()) || {};
    const printer = window.createLabelPrinter({ printerSelector: el['printer-selector'], printerName: el['printer-name'] }, render);
    const errors = { run: 'Production ended or changed. Refresh before creating another pallet.', lotChanged: 'The LOT changed. Review the current LOT and press again.', quantity: 'Check the case quantity.', packaging: 'The operator must configure this product’s packaging.', permission: 'Your employee assignment no longer permits this action.', conflict: 'Registration is busy. Retry the same pallet.', request: 'This request does not match its saved pallet. Ask the operator to check it.', pallet: 'This pallet is unavailable or voided.' };
    function workKey() { return `productionMobile:work:${lineId}:${session?.employeeId || ''}`; }
    function saveWork() { localStorage.setItem(workKey(), JSON.stringify(work)); }
    function message(text = '', error = false) { el.message.textContent = text; el.message.classList.toggle('error', error); }
    function setSession(value) {
        sessionVersion++;
        session = value; context = null; boxes = null; ready = false; refreshing = false;
        if (value) sessionStorage.setItem(sessionKey, JSON.stringify(value));
        else sessionStorage.removeItem(sessionKey);
        work = value ? read(localStorage, workKey()) || {} : {};
    }
    async function api(path, body) {
        const version = sessionVersion;
        let expired = false;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);
        try {
            const response = await fetch(`${base}/${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal });
            const data = await response.json();
            if (version !== sessionVersion) throw Object.assign(new Error('Session changed'), { stale: true });
            if (!response.ok) {
                const error = new Error(errors[data.message?.split('.').at(-1)] || data.message || 'Unable to complete the request.');
                error.code = data.message; error.status = response.status;
                if (response.status === 401) { expired = true; setSession(null); }
                throw error;
            }
            return data;
        } catch (error) {
            if (version !== sessionVersion && !expired) error.stale = true;
            throw error;
        } finally { clearTimeout(timeout); }
    }
    function render() {
        const run = context?.run || (context?.recoveryOnly ? work.pallet : null);
        el['login-form'].hidden = !!session;
        el['production-controls'].hidden = !session;
        el['employee-name'].textContent = session?.employeeName || '';
        el['product-name'].textContent = run?.productName || (context?.recoveryOnly ? 'Saved pallet recovery' : session ? 'No active production' : 'Sign in to your line');
        el['line-name'].textContent = run?.lineName || 'MES · Mobile labels';
        el['lot-number'].textContent = run?.lotNumber || '—';
        el['output-count'].textContent = String(context?.totals?.pillows || 0);
        el['cases-value'].textContent = String(work.pallet?.boxesPerPallet || work.pending?.boxes || boxes || '—');
        el['cases-button'].disabled = busy || !ready || !context?.run || !!work.pending || !!work.pallet;
        el['printer-selector'].disabled = busy || printer.busy || !navigator.bluetooth;
        el['bluetooth-support'].hidden = !!navigator.bluetooth && window.isSecureContext;
        el['login-button'].disabled = busy || !/^[a-f\d]{24}$/i.test(lineId);
        const quantityValid = Number.isSafeInteger(boxes) && boxes > 0 && boxes <= context?.run?.packaging?.boxesPerPallet;
        el['print-button'].disabled = busy || !session || !navigator.onLine || (!work.attempt?.result && (!printer.isConnected() || (!work.pallet && !work.pending && (!ready || !context?.run?.lotNumber || !quantityValid))));
        el['print-action'].textContent = busy ? 'Please wait…' : work.attempt?.result ? 'Save print result' : work.pallet ? 'Reprint saved pallet' : work.pending ? 'Retry same pallet' : 'Register & print pallet';
        el['saved-pallet'].textContent = work.pallet ? `Saved pallet ${work.pallet._id} · LOT ${work.pallet.lotNumber} · ${work.pallet.productName}` : '';
        el['next-pallet'].hidden = !work.pallet;
        el['next-pallet'].disabled = busy || !!work.attempt;
        el.refresh.disabled = busy || refreshing;
        el['sign-out'].disabled = busy;
    }
    async function refresh() {
        if (!session || busy || refreshing) return;
        const version = sessionVersion;
        refreshing = true;
        try {
            const latest = await api('context');
            if (context?.run?._id !== latest.run?._id) boxes = latest.run?.packaging?.boxesPerPallet || null;
            context = latest; ready = true;
        } catch (error) { if (!error.stale) { ready = false; message(error.message || 'Connection lost. Retry after reconnecting.', true); } }
        finally { if (version === sessionVersion) refreshing = false; render(); }
    }
    function labelCanvas(pallet) {
        const canvas = document.createElement('canvas'); canvas.width = 812; canvas.height = 1218;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 812, 1218); ctx.fillStyle = 'black'; ctx.textAlign = 'center';
        ctx.font = 'bold 44px Arial'; ctx.fillText('Down Home', 406, 90);
        ctx.font = 'bold 42px Arial'; ctx.fillText(pallet.productName || '', 406, 190, 740);
        ctx.font = '32px Arial'; ctx.fillText(pallet.styleCode || '', 406, 255);
        ctx.font = '26px Arial'; ctx.fillText('LOT NUMBER', 406, 365);
        ctx.font = 'bold 52px Arial'; ctx.fillText(pallet.lotNumber, 406, 440, 740);
        const barcode = document.createElement('canvas');
        window.JsBarcode(barcode, pallet._id, { format: 'CODE39', width: 2, height: 135, displayValue: true, fontSize: 24, margin: 15 });
        ctx.drawImage(barcode, 36, 510, 740, 230);
        ctx.font = 'bold 38px Arial'; ctx.fillText(`${pallet.boxesPerPallet} cases · ${pallet.quantity} products`, 406, 845, 740);
        ctx.font = '26px Arial'; ctx.fillText(pallet.lineName || '', 406, 930, 740);
        const stamp = new Date(pallet.registeredAt).toLocaleString('en-US', { timeZone: pallet.timeZone || 'America/New_York' });
        ctx.fillText(stamp, 406, 1010, 740); ctx.fillText(pallet.timeZone || '', 406, 1055);
        return canvas;
    }
    async function savePrintResult() {
        await api('print-result', { palletId: work.pallet._id, requestId: work.attempt.requestId, result: work.attempt.result });
        const submitted = work.attempt.result === 'Submitted';
        delete work.attempt; saveWork();
        message(submitted ? 'Label sent to printer. Use Next pallet for the next physical pallet.' : 'Print failed. Reconnect and reprint this saved pallet.', !submitted);
    }
    async function print() {
        if (el['print-button'].disabled) return;
        busy = true; message(); render();
        try {
            if (work.attempt?.result) { await savePrintResult(); return; }
            if (!work.pallet) {
                if (!work.pending) {
                    work.pending = { lineId, runId: context.run._id, lotNumber: context.run.lotNumber, boxes, requestId: crypto.randomUUID() }; saveWork();
                }
                try {
                    const result = await api('register', work.pending);
                    work.pallet = result.pallet; delete work.pending; saveWork();
                } catch (error) {
                    if (error.status === 409 && error.code !== 'productionPallet.errors.conflict') { delete work.pending; saveWork(); ready = false; }
                    throw error;
                }
            }
            if (work.attempt && !window.confirm('This label may already have printed. Print the same saved pallet again?')) return;
            const canvas = labelCanvas(work.pallet);
            work.attempt = { requestId: crypto.randomUUID(), printer: printer.name }; saveWork();
            await api('prepare-print', { palletId: work.pallet._id, ...work.attempt });
            try { await printer.print(canvas); work.attempt.result = 'Submitted'; }
            catch { work.attempt.result = 'Failed'; }
            saveWork(); await savePrintResult();
        } catch (error) { message(error.message || 'Connection lost. Retry the same pallet.', true); }
        finally { busy = false; render(); await refresh(); }
    }
    el['login-form'].addEventListener('submit', async event => {
        event.preventDefault(); if (busy) return;
        busy = true; message(); render();
        try { setSession(await api('login', { lineId, pin: el['employee-pin'].value })); el['employee-pin'].value = ''; }
        catch (error) { message(error.message || 'Unable to sign in.', true); }
        finally { busy = false; render(); await refresh(); }
    });
    el['printer-selector'].addEventListener('click', async () => { try { await printer.connect(); message('Printer connected.'); } catch (error) { message(error.message || 'Unable to connect printer.', true); } render(); });
    el['print-button'].addEventListener('click', print);
    el['next-pallet'].addEventListener('click', () => { if (busy || work.attempt) return; work = {}; saveWork(); boxes = context?.run?.packaging?.boxesPerPallet || null; message(); render(); refresh(); });
    el.refresh.addEventListener('click', refresh);
    el['sign-out'].addEventListener('click', () => { if (busy) return; setSession(null); message(); render(); });
    el['cases-button'].addEventListener('click', () => { el['cases-input'].value = boxes; el['cases-input'].max = context.run.packaging.boxesPerPallet; el['cases-limit'].textContent = `Maximum ${context.run.packaging.boxesPerPallet} cases per pallet`; el['cases-dialog'].showModal(); });
    el['cases-form'].addEventListener('submit', event => { const value = Number(el['cases-input'].value); if (!Number.isSafeInteger(value) || value < 1 || value > context?.run?.packaging?.boxesPerPallet) { event.preventDefault(); return; } boxes = value; render(); });
    el['cases-cancel'].addEventListener('click', () => el['cases-dialog'].close());
    window.addEventListener('online', refresh);
    window.addEventListener('offline', () => { ready = false; message('Offline. Reconnect before printing.', true); render(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    setInterval(() => { if (!document.hidden) refresh(); }, 15000);
    if (!/^[a-f\d]{24}$/i.test(lineId)) message('Open this tool using the link for your production line.', true);
    render(); refresh();
})();
