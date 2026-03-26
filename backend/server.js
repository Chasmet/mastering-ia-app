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

const upload = multer({
  storage: multer.memoryStorage()
});

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
      ok: false,
      error: error.message
    });
  }
});

app.post("/api/mastering-plan", async (req, res) => {
  try {
    const { userPrompt, analysis } = req.body;

    const systemPrompt = `
Tu es un ingénieur du son spécialisé en mastering professionnel.
Réponds en français.
Tu dois analyser les données fournies et retourner :
1. un résumé court
2. un preset JSON exploitable
    `.trim();

    const userMessage = `
Demande utilisateur :
${userPrompt || "Rends ce son parfait"}

Analyse audio :
${JSON.stringify(analysis || {}, null, 2)}
    `.trim();

    const response = await openai.responses.create({
      model: "gpt-5.4",
      input: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: userMessage
        }
      ]
    });

    return res.json({
      ok: true,
      result: response.output_text
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post("/api/save-test", async (req, res) => {
  try {
    const { name } = req.body;

    const { data, error } = await supabase
      .from("projects")
      .insert([{ name: name || "Projet test" }])
      .select();

    if (error) {
      throw error;
    }

    return res.json({
      ok: true,
      data
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.listen(port, () => {
  console.log(`Serveur démarré sur le port ${port}`);
});
