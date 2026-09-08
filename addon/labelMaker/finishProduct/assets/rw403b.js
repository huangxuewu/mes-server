// Shared RW403B encoder and connection used by the original and mobile label pages.
window.createLabelPrinter = (elements, onChange) => {
    const MUNBYN_GATT = { service: 0xabf0, notify: 0xabf3, print: 0xabf4, control: 0xabf1 };
    const state = { connecting: false, printing: false, ble: { device: null, server: null, print: null, control: null, notify: null } };
    function concatBytes(...chunks) {
        const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const output = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            output.set(chunk, offset);
            offset += chunk.length;
        }
        return output;
    }

    function encodeVarint(value) {
        let number = value >>> 0;
        const bytes = [];
        while (number > 0x7f) {
            bytes.push((number & 0x7f) | 0x80);
            number >>>= 7;
        }
        bytes.push(number);
        return new Uint8Array(bytes);
    }

    function encodeSInt32(value) {
        return encodeVarint((value << 1) ^ (value >> 31));
    }

    function fieldVarint(field, value) {
        return concatBytes(encodeVarint((field << 3) | 0), encodeVarint(value));
    }

    function fieldSInt(field, value) {
        return concatBytes(encodeVarint((field << 3) | 0), encodeSInt32(value));
    }

    function fieldBytes(field, value) {
        return concatBytes(encodeVarint((field << 3) | 2), encodeVarint(value.length), value);
    }

    function encodePrintMessage({ page, imageData, dataLength, totalPackages, packageIndex, width, totalSections, sectionLength, sectionIndex }) {
        const fields = [
            fieldVarint(1, page),
            fieldBytes(2, imageData),
            fieldSInt(3, dataLength),
            fieldVarint(4, totalPackages),
            fieldVarint(5, packageIndex),
            fieldVarint(6, width),
            fieldVarint(7, totalSections),
            fieldVarint(8, 1),
            fieldSInt(10, sectionLength),
        ];
        if (sectionIndex) fields.push(fieldVarint(12, sectionIndex));
        return concatBytes(...fields);
    }

    function encodeSendMessage(eventType, sendData = new Uint8Array()) {
        const fields = [fieldVarint(1, eventType)];
        if (sendData.length) fields.push(fieldBytes(5, sendData));
        return concatBytes(...fields);
    }

    function packFrame(payload) {
        let checksum = 0;
        const output = new Uint8Array(4 + payload.length);
        output[0] = 0x55;
        output[1] = payload.length & 0xff;
        output[2] = (payload.length >> 8) & 0xff;
        checksum = output[0] ^ output[1] ^ output[2];
        output[2] |= (0x0c & checksum) << 4;
        output[3] = 0x03 & (checksum >> 4);
        for (let index = 0; index < payload.length; index += 1) checksum ^= payload[index];
        output[3] |= 0xfc & checksum;
        output.set(payload, 4);
        return output;
    }

    function splitBytes(bytes, size) {
        const chunks = [];
        for (let index = 0; index < bytes.length; index += size) {
            chunks.push(bytes.subarray(index, index + size));
        }
        return chunks;
    }

    function canvasToPackedMonochrome(canvas) {
        const context = canvas.getContext('2d', { willReadFrequently: true });
        const image = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const widthBytes = Math.ceil(canvas.width / 8);
        const bitmap = new Uint8Array(widthBytes * canvas.height);

        for (let y = 0; y < canvas.height; y += 1) {
            for (let x = 0; x < canvas.width; x += 1) {
                const pixel = (y * canvas.width + x) * 4;
                const gray = image[pixel] * 0.299 + image[pixel + 1] * 0.587 + image[pixel + 2] * 0.114;
                if (gray < 160) bitmap[y * widthBytes + (x >> 3)] |= 0x80 >> (x & 7);
            }
        }
        return { bitmap, widthBytes };
    }

    function makePrintFrames(canvas) {
        const compressor = window.heatshrink?.compress;
        if (!compressor) throw new Error('The label compressor did not load. Refresh the page and try again.');

        const { bitmap, widthBytes } = canvasToPackedMonochrome(canvas);
        const sections = splitBytes(bitmap, 10_240);
        const frames = [];

        sections.forEach((section, sectionIndex) => {
            const compressedResult = compressor(section);
            const compressed = compressedResult instanceof Uint8Array ? compressedResult : new Uint8Array(compressedResult);
            const packages = splitBytes(compressed, 400);
            packages.forEach((data, packageIndex) => {
                const printMessage = encodePrintMessage({
                    page: 1,
                    imageData: data,
                    dataLength: bitmap.length,
                    totalPackages: packages.length,
                    packageIndex: packageIndex + 1,
                    width: packageIndex === 0 ? widthBytes : 0,
                    totalSections: sections.length,
                    sectionLength: compressed.length,
                    sectionIndex: sectionIndex + 1,
                });
                frames.push(packFrame(encodeSendMessage(4, printMessage)));
            });
        });
        return frames;
    }

    function makeControlFrame(eventType) {
        return packFrame(encodeSendMessage(eventType));
    }

    function isPrinterConnected() {
        return Boolean(
            state.ble.device?.gatt?.connected &&
            state.ble.print &&
            state.ble.control
        );
    }

    function setPrinterAppearance(mode, name) {
        elements.printerSelector.classList.toggle('connected', mode === 'connected');
        elements.printerSelector.classList.toggle('connecting', mode === 'connecting');
        elements.printerName.textContent = name;
    }

    function resetBluetooth() {
        state.ble = { device: null, server: null, print: null, control: null, notify: null };
        state.connecting = false;
        setPrinterAppearance('disconnected', 'RW403B');
        onChange();
    }

    async function connectPrinter() {
        if (!navigator.bluetooth) throw new Error('Bluetooth printing requires a supported browser such as Android Chrome over HTTPS.');
        if (state.connecting || state.printing) return;

        state.connecting = true;
        setPrinterAppearance('connecting', 'Searching…');
        onChange();

        try {
            const previousDevice = state.ble.device;

            const device = await navigator.bluetooth.requestDevice({
                filters: [{ namePrefix: 'RW403B' }],
                optionalServices: [MUNBYN_GATT.service],
            });
            const server = await device.gatt.connect();
            const service = await server.getPrimaryService(MUNBYN_GATT.service);
            const print = await service.getCharacteristic(MUNBYN_GATT.print);
            const control = await service.getCharacteristic(MUNBYN_GATT.control);
            let notify = null;

            try {
                notify = await service.getCharacteristic(MUNBYN_GATT.notify);
                if (notify.properties.notify) await notify.startNotifications();
            } catch {
                notify = null;
            }

            if (previousDevice && previousDevice !== device && previousDevice.gatt?.connected) {
                state.ble = { device: null, server: null, print: null, control: null, notify: null };
                previousDevice.gatt.disconnect();
            }

            device.addEventListener('gattserverdisconnected', () => {
                if (state.ble.device === device) resetBluetooth();
            });
            state.ble = { device, server, print, control, notify };
            setPrinterAppearance('connected', device.name || 'RW403B');
        } catch (error) {
            resetBluetooth();
            throw error;
        } finally {
            state.connecting = false;
            onChange();
        }
    }


    const print = async canvas => {
        if (!isPrinterConnected() || state.printing) throw new Error('Connect the printer before printing.');
        state.printing = true;
        onChange();
        try {
            const frames = makePrintFrames(canvas);
            await state.ble.control.writeValue(makeControlFrame(1));
            for (const frame of frames) {
                await state.ble.print.writeValue(frame);
                await new Promise(resolve => setTimeout(resolve, 3));
            }
            await state.ble.control.writeValue(makeControlFrame(10));
        } catch (error) {
            if (!state.ble.device?.gatt?.connected) resetBluetooth();
            throw error;
        } finally { state.printing = false; onChange(); }
    };
    return { connect: connectPrinter, print, isConnected: isPrinterConnected, get busy() { return state.connecting || state.printing; }, get name() { return state.ble.device?.name || 'RW403B'; } };
};
