const CHUNK_SIZE = 48 * 1024;
const ended = transfer => !transfer || ['complete', 'declined', 'cancelled', 'failed', 'timeout'].includes(transfer.status);

export const createPhoneTransfer = ({ selfId, desktopId, iceServers, signal, alive, changed, batchName = 'Phone upload' }) => {
    let connection, transfer, sourceFiles = [], signalQueue = Promise.resolve();
    const update = status => { if (transfer) transfer.status = status; changed(transfer); };
    const waitFor = (peer, key, timeout = 30000) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { peer.pending.delete(key); reject(new Error('timeout')); }, timeout);
        peer.pending.set(key, { resolve, reject, timer });
    });
    const acknowledge = (peer, key) => {
        const pending = peer.pending.get(key);
        if (!pending) return;
        clearTimeout(pending.timer); peer.pending.delete(key); pending.resolve();
    };
    const stopTransfer = status => {
        if (ended(transfer)) return;
        update(status); sourceFiles = [];
        for (const [key, pending] of connection?.pending || []) {
            if (key === 'open') continue;
            clearTimeout(pending.timer); pending.reject(new Error(status)); connection.pending.delete(key);
        }
    };
    const close = (status = 'failed', inform = true) => {
        stopTransfer(status);
        const peer = connection;
        connection = null;
        if (!peer) return;
        if (inform && peer.connectionId) void signal('close', { connectionId: peer.connectionId }).catch(() => {});
        peer.pc.close();
        for (const pending of peer.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(status)); }
        peer.pending.clear();
    };
    const writable = async channel => {
        if (!alive() || channel.readyState !== 'open') throw new Error('failed');
        if (channel.bufferedAmount < 65536) return;
        await new Promise((resolve, reject) => {
            const finish = error => { clearTimeout(timer); channel.removeEventListener('bufferedamountlow', low); channel.removeEventListener('close', closed); error ? reject(new Error(error)) : resolve(); };
            const low = () => finish(), closed = () => finish('failed');
            const timer = setTimeout(() => finish('timeout'), 30000);
            channel.addEventListener('bufferedamountlow', low, { once: true }); channel.addEventListener('close', closed, { once: true });
        });
    };
    const send = (peer, message) => {
        const operation = peer.sendQueue.then(async () => {
            const text = JSON.stringify(message), count = Math.ceil(text.length / 3000), id = crypto.randomUUID();
            if (count > 701) throw new Error('failed');
            for (let index = 0; index < count; index++) {
                await writable(peer.control);
                peer.control.send(JSON.stringify({ id, count, index, value: text.slice(index * 3000, (index + 1) * 3000) }));
            }
        });
        peer.sendQueue = operation.catch(() => {});
        return operation;
    };
    const sendFiles = async peer => {
        const current = transfer, files = sourceFiles;
        current.lastActivity = Date.now(); update('sending');
        const pending = new Set();
        try {
            for (let index = 0; index < files.length; index++) {
                const file = files[index];
                for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
                    const contents = new Uint8Array(await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer());
                    await writable(peer.files);
                    if (transfer !== current || current.status !== 'sending' || !alive()) return;
                    const frame = new Uint8Array(48 + contents.length), header = new DataView(frame.buffer);
                    frame.set(new TextEncoder().encode(current.id)); header.setUint32(36, index); header.setFloat64(40, offset); frame.set(contents, 48);
                    const receipt = waitFor(peer, `chunk:${current.id}:${index}:${offset + contents.length}`).then(() => {
                        pending.delete(receipt);
                        if (current.status !== 'sending') return;
                        current.bytes += contents.length; current.lastActivity = Date.now(); changed(current);
                    });
                    receipt.catch(() => {}); pending.add(receipt); peer.files.send(frame);
                    if (pending.size >= 16) await Promise.race(pending);
                }
            }
            await Promise.all(pending);
            if (current.status !== 'sending' || !alive()) return;
            update('finishing');
            const receipt = waitFor(peer, `finish:${current.id}`); receipt.catch(() => {});
            await send(peer, { type: 'finish', id: current.id }); await receipt;
            if (current.status !== 'finishing') return;
            sourceFiles = []; update('complete');
        } catch (error) {
            if (ended(current)) return;
            stopTransfer(error.message === 'timeout' ? 'timeout' : 'failed');
            void send(peer, { type: 'cancel', id: current.id }).catch(() => {});
        }
    };
    const receive = (peer, message) => {
        if (!alive() || peer !== connection) return close();
        if (!message || typeof message.type !== 'string' || !/^[a-f0-9-]{36}$/i.test(message.id)) throw new Error('failed');
        if (!transfer || transfer.id !== message.id) return;
        if (message.type === 'accept' && transfer.status === 'waiting') { void sendFiles(peer); return; }
        if (message.type === 'decline') return stopTransfer('declined');
        if (message.type === 'cancel') return stopTransfer('cancelled');
        if (message.type === 'chunkAck') return acknowledge(peer, `chunk:${message.id}:${message.index}:${message.offset}`);
        if (message.type === 'complete') return acknowledge(peer, `finish:${message.id}`);
        throw new Error('failed');
    };
    const createPeer = () => {
        if (connection) return connection;
        if (!alive()) throw new Error('failed');
        const pc = new RTCPeerConnection({ iceServers });
        const control = pc.createDataChannel('mes-sharing', { negotiated: true, id: 0, ordered: true });
        const files = pc.createDataChannel('mes-files', { negotiated: true, id: 1, ordered: true });
        const activity = pc.createDataChannel('mes-chat-activity', { negotiated: true, id: 2, ordered: true });
        const peer = { pc, control, files, activity, pending: new Map(), candidates: [], sendQueue: Promise.resolve(),
            connectionId: selfId < desktopId ? crypto.randomUUID() : null, started: false, fragment: null };
        connection = peer;
        control.bufferedAmountLowThreshold = files.bufferedAmountLowThreshold = 16384;
        control.onopen = files.onopen = () => { if (control.readyState === 'open' && files.readyState === 'open') acknowledge(peer, 'open'); };
        control.onclose = files.onclose = () => { if (connection === peer) close('failed', false); };
        files.onmessage = () => close();
        pc.onconnectionstatechange = () => { if (connection === peer && ['failed', 'closed'].includes(pc.connectionState)) close(); };
        pc.onicecandidate = event => {
            if (event.candidate && peer.connectionId) void signal('candidate', { connectionId: peer.connectionId, candidate: event.candidate.toJSON() }).catch(() => { if (connection === peer) close(); });
        };
        control.onmessage = event => {
            try {
                if (typeof event.data !== 'string' || event.data.length > 16000) throw new Error('failed');
                const part = JSON.parse(event.data);
                if (!Number.isInteger(part.count) || part.count < 1 || part.count > 701 || typeof part.value !== 'string' || part.value.length > 3000) throw new Error('failed');
                if (part.index === 0) { if (peer.fragment) throw new Error('failed'); peer.fragment = { id: part.id, count: part.count, next: 0, text: '' }; }
                const fragment = peer.fragment;
                if (!fragment || fragment.id !== part.id || fragment.count !== part.count || part.index !== fragment.next) throw new Error('failed');
                fragment.text += part.value; fragment.next++;
                if (fragment.next !== fragment.count) return;
                peer.fragment = null; receive(peer, JSON.parse(fragment.text));
            } catch { close(); }
        };
        return peer;
    };
    const offer = async peer => {
        if (peer.started) return;
        peer.started = true;
        await peer.pc.setLocalDescription(await peer.pc.createOffer());
        await signal('offer', { connectionId: peer.connectionId, description: peer.pc.localDescription.toJSON() });
    };
    const handleSignal = input => {
        signalQueue = signalQueue.then(async () => {
            if (input.from !== desktopId || !alive()) return;
            if (input.type === 'close') { if (connection?.connectionId === input.data?.connectionId) close('failed', false); return; }
            if (input.type !== 'request' && !/^[a-f0-9-]{36}$/i.test(input.data?.connectionId)) return;
            const peer = createPeer();
            if (input.type === 'request') { if (selfId < desktopId) await offer(peer); return; }
            if (peer.connectionId && peer.connectionId !== input.data.connectionId) return;
            peer.connectionId = input.data.connectionId;
            if (input.type === 'candidate') {
                peer.pc.remoteDescription ? await peer.pc.addIceCandidate(input.data.candidate) : peer.candidates.push(input.data.candidate);
                if (peer.candidates.length > 100) throw new Error('failed');
                return;
            }
            if (input.type === 'offer' && selfId < desktopId) return;
            await peer.pc.setRemoteDescription(input.data.description);
            for (const candidate of peer.candidates.splice(0)) await peer.pc.addIceCandidate(candidate);
            if (input.type === 'offer') {
                await peer.pc.setLocalDescription(await peer.pc.createAnswer());
                await signal('answer', { connectionId: peer.connectionId, description: peer.pc.localDescription.toJSON() });
            }
        }).catch(() => close());
        return signalQueue;
    };
    const request = async files => {
        if (!ended(transfer) || !alive() || !files.length || files.length > 10000) return false;
        const names = new Set();
        const entries = files.map(file => {
            let name = file.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 200).replace(/[. ]+$/, '') || 'file';
            if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
            const base = name; let suffix = 1;
            while (names.has(name.toLowerCase())) name = `${suffix++}-${base}`;
            names.add(name.toLowerCase());
            return { path: name, type: 'file', size: file.size };
        });
        const total = entries.reduce((sum, entry) => sum + entry.size, 0);
        if (!Number.isSafeInteger(total) || entries.some(entry => !Number.isSafeInteger(entry.size) || entry.size < 0)) return false;
        sourceFiles = Array.from(files);
        transfer = { id: crypto.randomUUID(), manifest: { kind: files.length === 1 ? 'file' : 'folder', name: files.length === 1 ? entries[0].path : batchName, entries, total, files: files.length },
            status: 'connecting', bytes: 0, at: Date.now() };
        const current = transfer;
        changed(current);
        try {
            const peer = createPeer();
            if (peer.control.readyState !== 'open' || peer.files.readyState !== 'open') {
                const ready = waitFor(peer, 'open', 20000); ready.catch(() => {});
                selfId < desktopId ? await offer(peer) : await signal('request', {});
                await ready;
            }
            if (current !== transfer || ended(current) || !alive()) return false;
            current.at = Date.now(); update('waiting');
            await send(peer, { type: 'offer', id: current.id, manifest: current.manifest });
            return true;
        } catch (error) { if (current === transfer) close(error.message === 'timeout' ? 'timeout' : 'failed'); return false; }
    };
    const cancel = () => {
        if (ended(transfer)) return;
        const id = transfer.id;
        stopTransfer('cancelled');
        if (connection) void send(connection, { type: 'cancel', id }).catch(() => {});
    };
    const tick = () => {
        if (ended(transfer)) return;
        if (!alive()) return close('cancelled');
        if ((transfer.status === 'waiting' && Date.now() - transfer.at >= 120000)
            || (transfer.status === 'sending' && Date.now() - transfer.lastActivity >= 30000)) {
            cancel(); update('timeout');
        }
    };
    return { request, handleSignal, cancel, close, tick };
};
