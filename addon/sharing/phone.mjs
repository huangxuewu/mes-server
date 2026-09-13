import { createPhoneTransfer } from './transfer.mjs';
import { labels } from './labels.mjs';

const element = id => document.getElementById(id);
const terminal = transfer => !transfer || ['complete', 'declined', 'cancelled', 'failed', 'timeout'].includes(transfer.status);
let language = navigator.language.startsWith('zh') ? 'cn' : navigator.language.split('-')[0];
let text = labels[language] || labels.en;
let session, engine, socket, selected = [], transfer, stopped = false, lastInteraction = 0, frame;
const applyLanguage = value => {
    language = labels[value] ? value : 'en'; text = labels[language];
    document.documentElement.lang = language === 'cn' ? 'zh' : language;
    document.title = `MES · ${text.title}`;
    document.querySelectorAll('[data-label]').forEach(node => { node.textContent = text[node.dataset.label]; });
    element('progress').setAttribute('aria-label', text.progress);
};
applyLanguage(language);
const alive = () => !stopped && session && Date.now() < Math.min(session.expiresAt, session.idleExpiresAt);
const render = () => {
    frame = null;
    const busy = !terminal(transfer), available = alive() && socket?.connected;
    element('images').disabled = element('files').disabled = !available || busy;
    element('send').disabled = !available || busy || !selected.length;
    element('selection').hidden = !selected.length || busy;
    element('transfer').hidden = !transfer;
    if (transfer) {
        const percentage = transfer.status === 'complete' ? 100 : transfer.manifest.total ? Math.min(99, Math.floor(transfer.bytes / transfer.manifest.total * 100)) : 0;
        element('transfer-name').textContent = transfer.manifest.name;
        element('transfer-status').textContent = text[transfer.status] || text.failed;
        element('progress').value = percentage; element('percentage').textContent = `${percentage}%`;
        element('cancel').hidden = !busy;
    }
    if (session) element('expires').textContent = text.expires + new Date(Math.min(session.expiresAt, session.idleExpiresAt)).toLocaleString(document.documentElement.lang);
};
const changed = value => { transfer = value; if (!frame) frame = requestAnimationFrame(render); };
const stop = reason => {
    stopped = true; engine?.close('cancelled'); socket?.disconnect();
    element('session-status').textContent = text[reason] || text.ended;
    selected = []; element('file-picker').value = element('image-picker').value = '';
    render();
};
const activity = () => {
    if (!alive() || !socket?.connected || Date.now() - lastInteraction < 1000) return;
    lastInteraction = Date.now();
    socket.emit('phone:activity', {}, result => { if (result?.status === 'error') stop('expired'); });
};
for (const event of ['pointerdown', 'keydown', 'change', 'scroll']) document.addEventListener(event, event => { if (event.isTrusted) activity(); }, { passive: true, capture: true });
for (const [button, picker] of [['images', 'image-picker'], ['files', 'file-picker']]) {
    element(button).onclick = () => { element(picker).value = ''; element(picker).click(); };
    element(picker).onchange = event => {
        if (!alive()) return stop('expired');
        selected = Array.from(event.target.files || []);
        element('error').textContent = '';
        if (selected.length > 10000 || !Number.isSafeInteger(selected.reduce((total, file) => total + file.size, 0))) {
            selected = []; element('error').textContent = text.selectionError; render(); return;
        }
        element('file-list').replaceChildren(...selected.map(file => {
            const row = document.createElement('li'); row.textContent = `${file.name} · ${file.size.toLocaleString()} B`; return row;
        }));
        render();
    };
}
element('send').onclick = async () => {
    activity();
    const files = selected; selected = []; render();
    if (!await engine?.request(files) && !transfer) element('error').textContent = text.selectionError;
    element('file-picker').value = element('image-picker').value = '';
    render();
};
element('cancel').onclick = () => engine?.cancel();
const invite = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
if (!globalThis.RTCPeerConnection || !crypto.randomUUID || !globalThis.io) stop('unsupported');
else if (!/^[a-f0-9]{64}$/.test(invite)) stop('unavailable');
else {
    const key = Array.from(crypto.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, '0')).join('');
    socket = io('/sharing-phone', { path: '/socket', transports: ['websocket'], autoConnect: false, auth: { invite, key } });
    socket.on('phone:state', state => {
        session = { ...session, ...state };
        if (['cancelled', 'expired'].includes(state.status)) return stop(state.status === 'expired' ? 'expired' : 'ended');
        element('session-status').textContent = text[state.status] || text.connecting; render();
    });
    socket.on('phone:ready', state => {
        if (stopped) return;
        session = state; socket.auth = { id: state.id, key }; applyLanguage(state.language);
        element('desktop').textContent = state.desktopName;
        element('session-status').textContent = text.connected;
        engine?.close('failed', false);
        engine = createPhoneTransfer({ selfId: state.peerId, desktopId: state.desktopId, iceServers: state.iceServers, alive, changed, batchName: text.batch,
            signal: (type, data) => new Promise((resolve, reject) => {
                if (!socket.connected || !alive()) return reject(new Error('failed'));
                socket.timeout(8000).emit('phone:signal', { to: state.desktopId, type, data }, (error, result) => error || result?.status !== 'success' ? reject(new Error('failed')) : resolve());
            }) });
        render();
    });
    socket.on('phone:signal', input => { void engine?.handleSignal(input); });
    socket.on('disconnect', () => { engine?.close('failed', false); if (!stopped) element('session-status').textContent = text.reconnecting; render(); });
    socket.on('connect_error', error => {
        if (['phoneExpired', 'phoneInUse'].includes(error.message)) return stop('unavailable');
        element('session-status').textContent = text.reconnecting; render();
    });
    window.addEventListener('pagehide', () => {
        if (session && !stopped) navigator.sendBeacon('/sharing/end', new Blob([JSON.stringify({ id: session.id, key })], { type: 'application/json' }));
        stop('ended');
    });
    socket.connect();
}
setInterval(() => {
    if (session && !stopped && !alive()) return stop('expired');
    engine?.tick();
}, 1000);
document.addEventListener('visibilitychange', () => { if (session && !stopped && !alive()) stop('expired'); });
render();
