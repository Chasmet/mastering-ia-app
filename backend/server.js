import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.get("/", (req, res) => {
  res.json({
    ok: true,
    app: "mastering-ia-backend",
    message: "Backend actif"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "healthy"
  });
});

app.post("/api/analyze", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "Aucun fichier audio reçu"
      });
    }

    return res.json({
      ok: true,
      fileName: req.file.originalname,
      size: req.file.size,
      analysis: {
        message: "Analyse simulée prête pour la suite",
        lufs: -14.2,
        truePeakDb: -1.1,
        stereoWidth: "medium",
        vocalPresence: "good",
        lowEnd: "slightly heavy"
      }
    });
  } catch (error) {
    return res.status(500).json({
      ok
