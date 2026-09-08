(() => {
    'use strict';

    const LABEL = { widthDots: 812, heightDots: 1218 };
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
        printing: false,
    };

    const printer = window.createLabelPrinter(elements, updateControls);

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

    function updateControls() {
        const boxes = getBoxesValue();
        elements.printButton.disabled = !printer.isConnected() || !state.selectedProduct || !boxes || state.printing;
        elements.printerSelector.disabled = printer.busy || state.printing || !navigator.bluetooth;
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

    async function printHelloWorld() {
        if (elements.printButton.disabled || state.printing) return;
        state.printing = true;
        updateControls();
        try { await printer.print(makeHelloWorldCanvas()); }
        catch { /* Connection status is updated by the shared printer. */ }
        finally { state.printing = false; updateControls(); }
    }

    elements.printerSelector.addEventListener('click', async () => {
        try { await printer.connect(); }
        catch { /* Keep the existing disconnected appearance after a failed connection. */ }
    });
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

    syncBoxesDisplay();
    updateControls();
    loadProducts();
})();
