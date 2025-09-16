const db = require("../../models");
const { createCanvas } = require("canvas");
const { getDocument } = require("pdfjs-dist/legacy/build/pdf.js");

module.exports = (socket, io) => {
    // data is file array buffer
    socket.on("pdf:thumbnail", async (data, callback) => {
        try {
            const pdfData = new Uint8Array(data);
            const pdf = await getDocument(pdfData).promise;
            const page = await pdf.getPage(1);
            const viewport = page.getViewport({ scale: 1.5 });
            const canvas = createCanvas(viewport.width, viewport.height);
            const ctx = canvas.getContext("2d");
            await page.render({ canvasContext: ctx, viewport }).promise;
            const buffer = canvas.toBuffer("image/jpeg", { quality: 0.8 });

            callback({ status: "success", message: "PDF thumbnail created successfully", payload: buffer });
        } catch (error) {
            callback({ status: "error", message: error.message });
        }
    })
}