const axios = require('axios');
const { createCanvas } = require("canvas");
const { getDocument } = require("pdfjs-dist/legacy/build/pdf.js");

module.exports = (socket, io) => {

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