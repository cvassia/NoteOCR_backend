import { DocumentProcessorServiceClient } from "@google-cloud/documentai";
import { Buffer } from "buffer";
import cors from "cors";
import { AlignmentType, Document, Packer, Paragraph, TextRun } from "docx";
import dotenv from "dotenv";
import 'dotenv/config';
import express from "express";
import fs from "fs";
import mongoose from "mongoose";
import multer from "multer";
import path from "path";
import sharp from "sharp";
import { fileURLToPath } from "url";


/* ------------------ MongoDB Setup ------------------ */

const MONGODB_URI = process.env.MONGODB_URI;
mongoose.connect(MONGODB_URI)
    .then(() => console.log("Connected to MongoDB Atlas"))
    .catch(err => console.error("MongoDB connection error:", err));


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const documentSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    url: { type: String, required: true },
    text: { type: String },
    uploadedAt: { type: Date, default: Date.now }
});


const DocumentModel = mongoose.model("Document", documentSchema);


/* ------------------ Vercel Base64 Key Setup ------------------ */
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const keyPath = path.join(__dirname, 'vision-key.json');
    const keyBase64 = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    const keyJson = Buffer.from(keyBase64, 'base64').toString('utf-8');
    fs.writeFileSync(keyPath, keyJson);
}


/* ------------------ Optional dotenv ------------------ */
const envPath = path.resolve(".env");
if (fs.existsSync(envPath)) {
    console.log("Loading .env file");
    dotenv.config({ path: envPath });
} else {
    console.log(".env file not found, using defaults");
}


/* ------------------ Setup ------------------ */


const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

/* ------------------ Upload directory ------------------ */
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
app.use(express.static(uploadDir));

/* ------------------ Multer config ------------------ */
const storage = multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`),
});
const upload = multer({ storage });

/* ------------------ Env variables ------------------ */
const projectId = process.env.PROJECT_ID;
const location = process.env.LOCATION;
const processorId = process.env.PROCESSOR_ID;
const SERVER_URL = process.env.SERVER_URL || "http://localhost:3000";


/* ------------------ Document AI client ------------------ */
const client = new DocumentProcessorServiceClient({
    keyFilename: path.join(__dirname, "vision-key.json"),
    apiEndpoint: "eu-documentai.googleapis.com",
});

/* ------------------ Helpers ------------------ */
const convertToJPEG = async (inputPath) => {
    const ext = path.extname(inputPath).toLowerCase();
    if ([".heic", ".heif", ".png", ".tiff", ".tif", ".gif"].includes(ext)) {
        const outputPath = inputPath.replace(/\.[^.]+$/, "_converted.jpg");
        await sharp(inputPath).jpeg({ quality: 90 }).toFile(outputPath);
        return outputPath;
    }
    return inputPath;
};

const downscaleImage = async (inputPath) => {
    const stats = fs.statSync(inputPath);
    if (stats.size > 20 * 1024 * 1024) {
        const outputPath = inputPath.replace(/\.[^.]+$/, "_resized.jpg");
        await sharp(inputPath).resize({ width: 2000 }).jpeg({ quality: 90 }).toFile(outputPath);
        return outputPath;
    }
    return inputPath;
};

/* ------------------ OCR Endpoint ------------------ */
app.post("/ocr", upload.single("file"), async (req, res) => {

    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    let filePath = req.file.path;

    try {
        // Convert and downscale if needed
        filePath = await convertToJPEG(filePath);
        filePath = await downscaleImage(filePath);

        const rawBytes = fs.readFileSync(filePath);
        console.log("Sending file to Document AI. Size (bytes):", rawBytes.length);

        const request = {
            name: client.processorPath(projectId, location, processorId),
            rawDocument: {
                content: rawBytes,
                mimeType: "image/jpeg",
            },
        };

        const [result] = await client.processDocument(request);
        const doc = result.document;
        const text = doc?.text || "";

        /* ------------------ Build DOCX with formatting ------------------ */
        const paragraphs = [];

        (doc.pages || []).forEach((page) => {
            (page.paragraphs || []).forEach((para) => {
                const textRuns = (para.layout?.textAnchor?.textSegments || []).map((segment) => {
                    const start = parseInt(segment.startIndex || "0");
                    const end = parseInt(segment.endIndex || "0");
                    const wordText = text.slice(start, end);

                    // Bold or italic if detected
                    const bold = para.detectedLanguages?.[0]?.confidence > 0.9; // example
                    const italic = wordText.includes("_"); // simple placeholder

                    return new TextRun({
                        text: wordText + " ",
                        bold,
                        italics: italic,
                        font: "Arial",
                        size: 24, // 12pt
                    });
                });

                paragraphs.push(
                    new Paragraph({
                        children: textRuns,
                        alignment: AlignmentType.CENTER,
                        spacing: { after: 200 }, // space after paragraph
                    })
                );
            });
        });

        const docx = new Document({ sections: [{ children: paragraphs }] });
        const docFileName = `document_${new Date().toLocaleDateString("en-GB").replace(/\//g, '.').slice(0, 8)}.docx`
        const docPath = path.join(uploadDir, docFileName);

        const buffer = await Packer.toBuffer(docx);
        fs.writeFileSync(docPath, buffer);

        const { userId } = req.body;
        if (!userId) {
            return res.status(401).json({ error: "Missing userId" });
        }

        const newDoc = await DocumentModel.create({
            name: docFileName,
            text,
            url: `${SERVER_URL}/${docFileName}`,
            userId,
        });

        res.status(201).json({
            text,
            docxUrl: newDoc.url,
            document: newDoc,
        });


        // Cleanup uploaded/converted images
        fs.unlinkSync(req.file.path);
        if (filePath !== req.file.path) fs.unlinkSync(filePath);
    } catch (err) {
        console.error("Document AI OCR error:", err);
        res.status(500).json({ error: err.message });
    }
});

/* ------------------ Health check ------------------ */
app.get("/", (req, res) => res.send("OCR server running"));

/* ------------------ Documents list endpoint ------------------ */

//Get documents
app.get("/documents", async (req, res) => {
    try {
        // if (!fs.existsSync(uploadDir)) return res.json([]);

        // const files = fs.readdirSync(uploadDir);

        // const docs = files
        //     .filter(file => file.endsWith(".docx")) // only DOCX files
        //     .map(file => ({
        //         id: file,
        //         name: file.replace(/^\d+_/, ""),
        //         url: `${SERVER_URL}/${file}`,
        //         uploadedAt: fs.statSync(path.join(uploadDir, file)).birthtime,
        //     }));

        // res.json(docs);
        const userId = req.query.userId;
        if (!userId) return res.status(401).json({ error: "Unauthorized" });

        const docs = await DocumentModel
            .find({ userId })
            .sort({ uploadedAt: -1 });

        res.json(docs);
    } catch (err) {
        console.error("Error fetching documents:", err);
        res.status(500).json({ error: "Failed to fetch documents" });
    }
});

/* ------------------ Rename document ------------------ */
app.patch("/documents/:id", async (req, res) => {
    try {
        const { userId, name } = req.body;

        const doc = await DocumentModel.findOneAndUpdate(
            { _id: req.params.id, userId },
            { name },
            { new: true }
        );

        if (!doc) return res.sendStatus(404);
        res.json(doc);
    } catch (err) {
        console.error("Error renaming document:", err);
        res.status(500).json({ error: "Failed to rename document" });
    }
});

/* ------------------ Delete document ------------------ */
app.delete("/documents/:id", async (req, res) => {
    try {
        // const { id } = req.params;
        // const filePath = path.join(uploadDir, id);

        // if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Document not found" });

        // fs.unlinkSync(filePath);

        // res.json({ success: true });
        const { userId } = req.body;

        const doc = await DocumentModel.findOneAndDelete({
            _id: req.params.id,
            userId,
        });

        if (!doc) return res.sendStatus(404);
        res.sendStatus(200);
    } catch (err) {
        console.error("Error deleting document:", err);
        res.status(500).json({ error: "Failed to delete document" });
    }
});



/* ------------------ Start server ------------------ */
app.listen(PORT, () => {
    console.log(`OCR server running at http://localhost:${PORT}`);
});
