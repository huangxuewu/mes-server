(() => {
    'use strict';

    const LABEL = { widthDots: 812, heightDots: 1218 };
    const MUNBYN_GATT = {
        service: 0xabf0,
        notify: 0xabf3,
        print: 0xabf4,
        control: 0xabf1,
    };

    const elements = {
        printerSelector: document.getElementById('printer-selector'),
        printerName: document.getElementById('printer-name'),
        productList: document.getElementById('product-list'),
        productCount: document.getElementById('product-count'),
        productPickerButton: document.getElementById('product-picker-button'),
        productSheet: document.getElementById('product-sheet'),
        productSheetClose: document.getElementById('product-sheet-close'),
        boxesButton: document.getElementById('boxes-button'),
        boxesValue: document.getElementById('boxes-value'),
        boxesPad: document.getElementById('boxes-pad'),
        boxesPadValue: document.getElementById('boxes-pad-value'),
        boxesPadKeys: document.getElementById('boxes-pad-keys'),
        boxesPadDone: document.getElementById('boxes-pad-done'),
        selectedProduct: document.getElementById('selected-product'),
        printButton: document.getElementById('print-button'),
    };

    const state = {
        products: [],
        selectedProduct: null,
        boxes: '',
        sheetOpen: false,
        padOpen: false,
        padReplaceNext: false,
        connecting: false,
        printing: false,
        ble: { device: null, server: null, print: null, control: null, notify: null },
    };

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

    function makeHelloWorldCanvas() {
        const canvas = document.createElement('canvas');
        canvas.width = LABEL.widthDots;
        canvas.height = LABEL.heightDots;
        const context = canvas.getContext('2d');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = '#000';
        context.font = '700 104px Arial, sans-serif';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText('Hello World', canvas.width / 2, canvas.height / 2, canvas.width - 96);
        return canvas;
    }

    function getDefaultBoxes() {
        const defaultBoxes = Number(state.selectedProduct?.packaging?.boxesPerPallet);
        return Number.isInteger(defaultBoxes) && defaultBoxes >= 1 && defaultBoxes <= 9999 ? String(defaultBoxes) : '';
    }

    function getBoxesValue() {
        const value = Number(state.boxes);
        return state.boxes !== '' && Number.isInteger(value) && value >= 1 && value <= 9999 ? value : null;
    }

    function syncBoxesDisplay() {
        const label = state.boxes || '—';
        elements.boxesValue.textContent = label;
        elements.boxesPadValue.textContent = label;
    }

    function setBoxes(value) {
        state.boxes = value;
        syncBoxesDisplay();
        updateControls();
    }

    function isPrinterConnected() {
        return Boolean(
            state.ble.device?.gatt?.connected &&
            state.ble.print &&
            state.ble.control
        );
    }

    function updateControls() {
        const boxes = getBoxesValue();
        elements.printButton.disabled = !isPrinterConnected() || !state.selectedProduct || !boxes || state.printing;
        elements.printerSelector.disabled = state.connecting || state.printing || !navigator.bluetooth;
        elements.boxesButton.disabled = !state.selectedProduct || state.printing;
        elements.printButton.textContent = state.printing ? 'Printing…' : 'Print';
    }

    function setBoxesPadOpen(open) {
        if (open && (!state.selectedProduct || state.printing)) return;
        state.padOpen = open;
        state.padReplaceNext = open;
        elements.boxesPad.hidden = !open;
        elements.boxesButton.setAttribute('aria-expanded', String(open));
        if (open) {
            setProductSheetOpen(false);
            syncBoxesDisplay();
        }
    }

    function handlePadKey(key) {
        if (key === 'clear') {
            state.padReplaceNext = true;
            return setBoxes(getDefaultBoxes());
        }
        if (key === 'back') {
            state.padReplaceNext = false;
            return setBoxes(state.boxes.slice(0, -1));
        }
        if (!/^\d$/.test(key)) return;
        if (state.padReplaceNext) {
            state.padReplaceNext = false;
            return setBoxes(key);
        }
        if (state.boxes.length >= 4) return;
        if (state.boxes === '0') return setBoxes(key);
        setBoxes(`${state.boxes}${key}`);
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
        updateControls();
    }

    async function connectPrinter() {
        if (!navigator.bluetooth || state.connecting || state.printing) return;

        state.connecting = true;
        setPrinterAppearance('connecting', 'Searching…');
        updateControls();

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
        } catch {
            resetBluetooth();
        } finally {
            state.connecting = false;
            updateControls();
        }
    }

    function productLabel(product) {
        return product.styleName || product.name || 'Unnamed product';
    }

    function formatStyleCode(value) {
        const text = String(value || '').trim();
        const digits = text.replace(/\D/g, '');
        return digits.length === 9 ? digits.replace(/(\d{3})(\d{2})(\d{4})/, '$1-$2-$3') : (text || 'No style code');
    }

    function setProductSheetOpen(open) {
        state.sheetOpen = open;
        elements.productSheet.hidden = !open;
        elements.productPickerButton.setAttribute('aria-expanded', String(open));
        document.body.style.overflow = open ? 'hidden' : '';
    }

    function selectProduct(product) {
        state.selectedProduct = product;
        setBoxes(getDefaultBoxes());
        elements.selectedProduct.textContent = formatStyleCode(product.styleCode);
        renderProducts();
        updateControls();
        setProductSheetOpen(false);
        if (!state.boxes) setBoxesPadOpen(true);
    }

    function clearSelectedProduct() {
        state.selectedProduct = null;
        setBoxes('');
        elements.selectedProduct.textContent = '—';
        setBoxesPadOpen(false);
    }

    function renderProducts() {
        elements.productCount.textContent = String(state.products.length);
        elements.productList.replaceChildren();

        for (const product of state.products) {
            const button = document.createElement('button');
            const code = document.createElement('strong');
            const name = document.createElement('span');
            button.type = 'button';
            button.className = 'product-option';
            button.setAttribute('role', 'option');
            button.setAttribute('aria-selected', String(state.selectedProduct?._id === product._id));
            if (state.selectedProduct?._id === product._id) button.classList.add('selected');
            code.textContent = formatStyleCode(product.styleCode);
            name.textContent = productLabel(product);
            button.append(code, name);
            button.addEventListener('click', () => selectProduct(product));
            elements.productList.append(button);
        }
    }

    function sortProducts(products) {
        return products
            .filter((product) => product?.status === 'Active')
            .sort((left, right) => String(left.styleCode || '').localeCompare(String(right.styleCode || '')));
    }

    function loadProducts() {
        if (typeof window.io !== 'function') return;

        const socketConfig = window.LABEL_MAKER_CONFIG || {};
        const socket = window.io({
            path: socketConfig.socketPath || '/socket',
            transports: ['websocket'],
            auth: { appToken: socketConfig.socketAppToken || '' },
        });

        socket.emit('product:fetch', { status: 'Active' }, (response) => {
            if (response?.status !== 'success' || !Array.isArray(response.payload)) return;
            state.products = sortProducts(response.payload);
            renderProducts();
        });

        socket.on('product:update', (product) => {
            const index = state.products.findIndex((item) => item._id === product?._id);
            if (product?.status !== 'Active') {
                if (index >= 0) state.products.splice(index, 1);
                if (state.selectedProduct?._id === product?._id) clearSelectedProduct();
            } else if (index >= 0) {
                state.products.splice(index, 1, product);
            } else {
                state.products.push(product);
            }
            state.products = sortProducts(state.products);
            renderProducts();
            updateControls();
        });

        socket.on('product:delete', (productId) => {
            state.products = state.products.filter((product) => product._id !== productId);
            if (state.selectedProduct?._id === productId) clearSelectedProduct();
            renderProducts();
            updateControls();
        });
    }

    async function writeControl(bytes) {
        if (!state.ble.control) throw new Error('The printer control channel is unavailable.');
        await state.ble.control.writeValue(bytes);
    }

    async function printHelloWorld() {
        if (elements.printButton.disabled || state.printing) return;
        state.printing = true;
        updateControls();

        try {
            const frames = makePrintFrames(makeHelloWorldCanvas());
            await writeControl(makeControlFrame(1));

            for (let index = 0; index < frames.length; index += 1) {
                if (!state.ble.print) throw new Error('The printer data channel is unavailable.');
                await state.ble.print.writeValue(frames[index]);
                await new Promise((resolve) => window.setTimeout(resolve, 3));
            }

            await writeControl(makeControlFrame(10));
        } catch {
            if (!state.ble.device?.gatt?.connected) resetBluetooth();
        } finally {
            state.printing = false;
            updateControls();
        }
    }

    elements.printerSelector.addEventListener('click', connectPrinter);
    elements.productPickerButton.addEventListener('click', () => {
        setBoxesPadOpen(false);
        setProductSheetOpen(true);
    });
    elements.productSheetClose.addEventListener('click', () => setProductSheetOpen(false));
    elements.boxesButton.addEventListener('click', () => setBoxesPadOpen(true));
    elements.boxesPadDone.addEventListener('click', () => setBoxesPadOpen(false));
    elements.boxesPad.addEventListener('click', (event) => {
        if (event.target === elements.boxesPad) setBoxesPadOpen(false);
    });
    elements.boxesPadKeys.addEventListener('click', (event) => {
        const key = event.target.closest('button')?.dataset?.key;
        if (key) handlePadKey(key);
    });
    elements.printButton.addEventListener('click', printHelloWorld);
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && state.padOpen) return setBoxesPadOpen(false);
        if (event.key === 'Escape' && state.sheetOpen) return setProductSheetOpen(false);
        if (!state.padOpen) return;
        if (event.key === 'Backspace') return handlePadKey('back');
        if (event.key === 'Enter') return setBoxesPadOpen(false);
        if (/^\d$/.test(event.key)) handlePadKey(event.key);
    });

    if (!navigator.bluetooth) setPrinterAppearance('disconnected', 'RW403B');
    syncBoxesDisplay();
    updateControls();
    loadProducts();
})();
