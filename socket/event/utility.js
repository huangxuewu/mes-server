const path = require("path");
const axios = require('axios');
const db = require("../../models");
// const { createCanvas } = require("canvas");
// const { getDocument } = require("pdfjs-dist/legacy/build/pdf.js");
const { decryptString } = require("../../utils/passcodeCrypto");

module.exports = (socket, io) => {

    const normalizePdfBuffer = (data) => {
        if (!data) throw new Error("PDF data is required");

        if (Buffer.isBuffer(data)) return data;
        if (data instanceof ArrayBuffer) return Buffer.from(data);
        if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);

        if (data?.type === 'Buffer' && Array.isArray(data.data)) {
            return Buffer.from(data.data);
        }

        if (typeof data === 'string') {
            if (data.startsWith('data:application/pdf;base64,')) {
                return Buffer.from(data.split(',')[1], 'base64');
            }
            return Buffer.from(data, 'base64');
        }

        throw new Error(`Unsupported PDF payload type: ${typeof data}`);
    };

    // get image from url
    // the purpose is to remove the cross origin policy, because the image is from another domain

    socket.on('utility:get_image', async (url, callback) => {
        try {
            const response = await axios.get(url, {
                responseType: 'arraybuffer',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'image/*,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Accept-Encoding': 'gzip, deflate',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache'
                },
                timeout: 10000, // 10 second timeout
                maxContentLength: 10 * 1024 * 1024, // 10MB max file size
                maxRedirects: 5, // Allow redirects
                validateStatus: function (status) {
                    return status >= 200 && status < 300;
                }
            });

            const imageBuffer = Buffer.from(response.data);

            // Validate that we actually got image data
            if (imageBuffer.length === 0) {
                throw new Error('No image data received');
            }

            // For canvas usage, we don't need to detect image type

            const base64Image = imageBuffer.toString('base64');

            callback({
                status: "success",
                message: "Image fetched successfully",
                payload: base64Image
            });
        } catch (error) {
            let errorMessage = 'Failed to fetch image';

            if (error.code === 'ECONNABORTED') {
                errorMessage = 'Request timeout - image took too long to load';
            } else if (error.response) {
                errorMessage = `HTTP ${error.response.status}: ${error.response.statusText}`;
            } else if (error.code === 'ENOTFOUND') {
                errorMessage = 'Image URL not found';
            } else if (error.message) {
                errorMessage = error.message;
            }

            callback({ status: "error", message: errorMessage });
        }
    })

    socket.on("pdf:thumbnail", async (data, callback) => {
        try {
            const pdfBuffer = normalizePdfBuffer(data);

            const { pdf } = await import("pdf-to-img");
            const doc = await pdf(pdfBuffer, { scale: 1.5 });

            let page1 = null;
            if (typeof doc.getPage === 'function') {
                page1 = await doc.getPage(1);
            } else {
                for await (const image of doc) {
                    page1 = image;
                    break;
                }
            }

            if (!page1) {
                throw new Error("Failed to render first page");
            }

            const payload = Buffer.isBuffer(page1) ? page1 : Buffer.from(page1);
            callback({ status: "success", message: "PDF thumbnail created successfully", payload });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    })

    socket.on("passcode:create", async (data, callback) => {
        try {
            const passcode = await db.passcode.create(data);
            callback({ status: "success", message: "Passcode created successfully", payload: passcode });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    })

    socket.on("passcode:update", async (data, callback) => {
        try {
            const { _id, ...update } = data;
            const passcode = await db.passcode.findByIdAndUpdate(_id, { $set: update }, { new: true });
            callback({ status: "success", message: "Passcode updated successfully", payload: passcode });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    })

    socket.on("passcode:delete", async (data, callback) => {
        try {
            const { _id } = data;
            await db.passcode.findByIdAndDelete(_id);
            callback({ status: "success", message: "Passcode deleted successfully" });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    })

    socket.on("passcode:fetch", async (data = {}, callback) => {
        try {
            const passcodes = await db.passcode.find(data);
            callback({ status: "success", message: "Passcodes fetched successfully", payload: passcodes });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    })


    socket.on("passcode:decrypt", async (data, callback) => {
        try {
            const { _id, passcode } = data;
            const value = decryptString(passcode);
            callback({ status: "success", message: "Passcode decrypted successfully", payload: { _id, value } });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    })
}