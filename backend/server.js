import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import ffmpegPath from "ffmpeg-static";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";

dotenv.config();

const execFileAsync = promisify(execFile);

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024
  }
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function makeTempFilePath(ext = ".wav") {
  const id = crypto.randomUUID();
  return path.join(os.tmpdir(), `${id}${ext}`);
}

async function runFfmpeg(args) {
  if (!ffmpegPath) {
    throw new Error("FFmpeg introuvable sur le serveur");
  }

  return execFileAsync(ffmpegPath, args);
}

function buildMasteringFilter(planText = "") {
  const text = planText.toLowerCase();

  let compressor = "acompressor=threshold=-18dB:ratio=2.5:attack=20:release=250:makeup=3";
  let loudnorm = "loudnorm=I=-14:TP=-1.0:LRA=11";
  let tone = "equalizer=f=90:t=q:w=1.0:g=1.5,equalizer=f=3500:t=q:w=1.0:g=1.0";
  let cleanup = "highpass=f=28,lowpass=f=17500";

  if (text.includes("low end") || text.includes("heavy")) {
    tone = "equalizer=f=90:t=q:w=1.0:g=-1.5,equalizer=f=3500:t=q:w=1.0:g=1.2";
  }

  if (text.includes("vocal") || text.includes("presence")) {
    tone = "equalizer=f=90:t=q:w=1.0:g=0.8,equalizer=f=3500:t=q:w=1.0:g=2.0";
  }

  if (text.includes("puissant")) {
    compressor = "acompressor=threshold=-20dB:ratio=3.0:attack=15:release=220:makeup=4";
  }

  return `${cleanup},${tone},${compressor},${loudnorm}`;
}

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
Donne :
1. un résumé court
2. des consignes de mastering simples, concrètes et exploitables
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

app.post("/api/master", upload.single("audio"), async (req, res) => {
  let inputPath = "";
  let outputPath = "";

  try {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "Aucun fichier audio reçu"
      });
    }

    const userPrompt = req.body.userPrompt || "Rends ce son parfait";
    const analysis = req.body.analysis ? JSON.parse(req.body.analysis) : {};

    const planResponse = await openai.responses.create({
      model: "gpt-5.4",
      input: [
        {
          role: "system",
          content: "Tu es un ingénieur mastering. Réponds en français avec des consignes courtes et utiles."
        },
        {
          role: "user",
          content: `Demande: ${userPrompt}\nAnalyse: ${JSON.stringify(analysis, null, 2)}`
        }
      ]
    });

    const planText = planResponse.output_text || "";
    const filterChain = buildMasteringFilter(planText);

    inputPath = makeTempFilePath(".wav");
    outputPath = makeTempFilePath(".wav");

    await fs.writeFile(inputPath, req.file.buffer);

    await runFfmpeg([
      "-y",
      "-i",
      inputPath,
      "-vn",
      "-af",
      filterChain,
      "-ar",
      "44100",
      "-ac",
      "2",
      "-c:a",
      "pcm_s16le",
      outputPath
    ]);

    const outputBuffer = await fs.readFile(outputPath);
    const safeBaseName = (req.file.originalname || "master")
      .replace(/\.[^/.]+$/, "")
      .replace(/[^a-zA-Z0-9-_]/g, "_");

    res.setHeader("Content-Type", "audio/wav");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeBaseName}_master.wav"`
    );
    res.setHeader("X-Mastering-Plan", encodeURIComponent(planText.slice(0, 500)));

    return res.send(outputBuffer);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  } finally {
    if (inputPath) {
      await fs.unlink(inputPath).catch(() => {});
    }
    if (outputPath) {
      await fs.unlink(outputPath).catch(() => {});
    }
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
