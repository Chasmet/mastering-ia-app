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

function safeNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function extractJson(text) {
  if (!text || typeof text !== "string") {
    throw new Error("Réponse JSON vide");
  }

  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch (_) {}

  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (codeBlockMatch?.[1]) {
    return JSON.parse(codeBlockMatch[1].trim());
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  }

  throw new Error("Impossible de parser le JSON du plan IA");
}

async function runPythonAnalyze(filepath) {
  const scriptPath = path.resolve("analyze.py");
  const candidates = ["python3", "python"];
  let lastError = null;

  for (const cmd of candidates) {
    try {
      const { stdout } = await execFileAsync(cmd, [scriptPath, filepath]);
      const parsed = JSON.parse(stdout);

      if (!parsed.ok) {
        throw new Error(parsed.error || "Analyse Python invalide");
      }

      return parsed.analysis;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Impossible d'exécuter analyze.py : ${lastError?.message || "erreur inconnue"}`
  );
}

function getDefaultPlan() {
  return {
    goal: "Embellir puis masteriser proprement le morceau",
    style: "auto",
    target_lufs: -14,
    true_peak_ceiling_db: -1,
    enhancement_intensity: 0.45,
    mastering_intensity: 0.55,
    enhancement_chain: [
      {
        tool: "enhance_tone",
        enabled: true,
        settings: {
          low_gain_db: 0.8,
          presence_gain_db: 1.0,
          air_gain_db: 0.6
        }
      },
      {
        tool: "enhance_glue",
        enabled: true,
        settings: {
          threshold_db: -18,
          ratio: 1.5,
          attack_ms: 30,
          release_ms: 220,
          makeup_gain_db: 0.8
        }
      }
    ],
    master_chain: [
      {
        tool: "cleanup",
        enabled: true,
        settings: {
          highpass_hz: 28,
          lowpass_hz: 17500
        }
      },
      {
        tool: "eq",
        enabled: true,
        settings: {
          low_gain_db: 0.3,
          presence_gain_db: 0.5,
          air_gain_db: 0.4
        }
      },
      {
        tool: "compressor",
        enabled: true,
        settings: {
          threshold_db: -17,
          ratio: 2.0,
          attack_ms: 22,
          release_ms: 180,
          makeup_gain_db: 1.2
        }
      },
      {
        tool: "limiter",
        enabled: true,
        settings: {
          limit_db: -1
        }
      },
      {
        tool: "loudnorm",
        enabled: true,
        settings: {
          target_lufs: -14,
          true_peak_db: -1
        }
      }
    ]
  };
}

function normalizeChain(chain) {
  return (Array.isArray(chain) ? chain : [])
    .filter((step) => step && typeof step === "object" && typeof step.tool === "string")
    .map((step) => ({
      tool: step.tool,
      enabled: step.enabled !== false,
      settings: step.settings && typeof step.settings === "object" ? step.settings : {}
    }));
}

function normalizePlan(plan) {
  const safePlan = plan && typeof plan === "object" ? plan : {};
  const fallback = getDefaultPlan();

  return {
    goal: typeof safePlan.goal === "string" ? safePlan.goal : fallback.goal,
    style: typeof safePlan.style === "string" ? safePlan.style : fallback.style,
    target_lufs: clamp(safeNumber(safePlan.target_lufs, -14), -18, -7),
    true_peak_ceiling_db: clamp(safeNumber(safePlan.true_peak_ceiling_db, -1), -2, -0.1),
    enhancement_intensity: clamp(safeNumber(safePlan.enhancement_intensity, 0.45), 0, 1),
    mastering_intensity: clamp(safeNumber(safePlan.mastering_intensity, 0.55), 0, 1),
    enhancement_chain: normalizeChain(
      safePlan.enhancement_chain?.length ? safePlan.enhancement_chain : fallback.enhancement_chain
    ),
    master_chain: normalizeChain(
      safePlan.master_chain?.length ? safePlan.master_chain : fallback.master_chain
    )
  };
}

async function buildPlanWithAI(userPrompt, analysis) {
  const systemPrompt = `
Tu es un ingénieur du son expert.
Tu dois embellir le morceau AVANT le mastering final.
Tu réponds uniquement avec un JSON valide.
Aucun texte avant.
Aucun texte après.
Aucun markdown.

Outils autorisés dans enhancement_chain :
- enhance_tone
- enhance_glue

Outils autorisés dans master_chain :
- cleanup
- eq
- compressor
- limiter
- loudnorm

Format obligatoire :
{
  "goal": "string",
  "style": "string",
  "target_lufs": -14,
  "true_peak_ceiling_db": -1,
  "enhancement_intensity": 0.45,
  "mastering_intensity": 0.55,
  "enhancement_chain": [],
  "master_chain": []
}

Règles :
- embellissement modéré, musical, jamais extrême
- si le morceau semble déjà traité, rester léger
- target_lufs entre -18 et -7
- true_peak_ceiling_db entre -2 et -0.1
- réponds uniquement avec le JSON
`.trim();

  const userMessage = `
Demande utilisateur :
${userPrompt || "Rends ce son plus beau puis masterise-le proprement"}

Analyse audio :
${JSON.stringify(analysis || {}, null, 2)}
`.trim();

  const response = await openai.responses.create({
    model: "gpt-5.4",
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage }
    ]
  });

  const parsed = extractJson(response.output_text || "");
  return normalizePlan(parsed);
}

function buildEqFilters(settings = {}) {
  const lowGain = clamp(safeNumber(settings.low_gain_db, 0), -6, 6);
  const presenceGain = clamp(safeNumber(settings.presence_gain_db, 0), -6, 6);
  const airGain = clamp(safeNumber(settings.air_gain_db, 0), -6, 6);

  const filters = [];

  if (lowGain !== 0) filters.push(`equalizer=f=90:t=q:w=1.0:g=${lowGain}`);
  if (presenceGain !== 0) filters.push(`equalizer=f=3500:t=q:w=1.0:g=${presenceGain}`);
  if (airGain !== 0) filters.push(`equalizer=f=10500:t=q:w=0.8:g=${airGain}`);

  return filters;
}

function buildEnhanceToneFilters(settings = {}) {
  const lowGain = clamp(safeNumber(settings.low_gain_db, 0.8), -4, 4);
  const presenceGain = clamp(safeNumber(settings.presence_gain_db, 1.0), -4, 4);
  const airGain = clamp(safeNumber(settings.air_gain_db, 0.6), -4, 4);

  const filters = [];

  if (lowGain !== 0) filters.push(`equalizer=f=110:t=q:w=1.2:g=${lowGain}`);
  if (presenceGain !== 0) filters.push(`equalizer=f=2800:t=q:w=1.0:g=${presenceGain}`);
  if (airGain !== 0) filters.push(`equalizer=f=9500:t=q:w=0.7:g=${airGain}`);

  return filters;
}

function buildEnhanceGlueFilters(settings = {}) {
  const thresholdDb = clamp(safeNumber(settings.threshold_db, -18), -30, -8);
  const ratio = clamp(safeNumber(settings.ratio, 1.5), 1.1, 3.5);
  const attackMs = clamp(safeNumber(settings.attack_ms, 30), 1, 200);
  const releaseMs = clamp(safeNumber(settings.release_ms, 220), 20, 1200);
  const makeupGainDb = clamp(safeNumber(settings.makeup_gain_db, 0.8), 0, 4);

  return [
    `acompressor=threshold=${thresholdDb}dB:ratio=${ratio}:attack=${attackMs}:release=${releaseMs}:makeup=${makeupGainDb}`
  ];
}

function buildChainFilters(chain, plan) {
  const filters = [];

  for (const step of chain) {
    if (!step.enabled) continue;

    const settings = step.settings || {};

    switch (step.tool) {
      case "enhance_tone":
        filters.push(...buildEnhanceToneFilters(settings));
        break;

      case "enhance_glue":
        filters.push(...buildEnhanceGlueFilters(settings));
        break;

      case "cleanup": {
        const highpassHz = clamp(safeNumber(settings.highpass_hz, 28), 20, 80);
        const lowpassHz = clamp(safeNumber(settings.lowpass_hz, 17500), 10000, 20000);
        filters.push(`highpass=f=${highpassHz}`);
        filters.push(`lowpass=f=${lowpassHz}`);
        break;
      }

      case "eq":
        filters.push(...buildEqFilters(settings));
        break;

      case "compressor": {
        const thresholdDb = clamp(safeNumber(settings.threshold_db, -17), -30, -6);
        const ratio = clamp(safeNumber(settings.ratio, 2.0), 1.1, 6);
        const attackMs = clamp(safeNumber(settings.attack_ms, 22), 1, 200);
        const releaseMs = clamp(safeNumber(settings.release_ms, 180), 20, 1000);
        const makeupGainDb = clamp(safeNumber(settings.makeup_gain_db, 1.2), 0, 8);

        filters.push(
          `acompressor=threshold=${thresholdDb}dB:ratio=${ratio}:attack=${attackMs}:release=${releaseMs}:makeup=${makeupGainDb}`
        );
        break;
      }

      case "limiter": {
        const limitDb = clamp(safeNumber(settings.limit_db, -1), -3, -0.1);
        const linear = Math.pow(10, limitDb / 20);
        filters.push(`alimiter=limit=${linear.toFixed(4)}`);
        break;
      }

      case "loudnorm": {
        const targetLufs = clamp(safeNumber(settings.target_lufs, plan.target_lufs ?? -14), -18, -7);
        const truePeakDb = clamp(safeNumber(settings.true_peak_db, plan.true_peak_ceiling_db ?? -1), -2, -0.1);
        filters.push(`loudnorm=I=${targetLufs}:TP=${truePeakDb}:LRA=11`);
        break;
      }

      default:
        break;
    }
  }

  return filters;
}

function buildFilterChainFromPlan(plan) {
  const enhanceFilters = buildChainFilters(plan.enhancement_chain || [], plan);
  const masterFilters = buildChainFilters(plan.master_chain || [], plan);
  const merged = [...enhanceFilters, ...masterFilters];

  if (!merged.length) {
    const fallback = getDefaultPlan();
    return [
      ...buildChainFilters(fallback.enhancement_chain, fallback),
      ...buildChainFilters(fallback.master_chain, fallback)
    ].join(",");
  }

  return merged.join(",");
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
  let inputPath = "";

  try {
    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "Aucun fichier audio reçu"
      });
    }

    const ext = path.extname(req.file.originalname || "") || ".wav";
    inputPath = makeTempFilePath(ext);

    await fs.writeFile(inputPath, req.file.buffer);
    const analysis = await runPythonAnalyze(inputPath);

    return res.json({
      ok: true,
      fileName: req.file.originalname,
      size: req.file.size,
      analysis
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  } finally {
    if (inputPath) {
      await fs.unlink(inputPath).catch(() => {});
    }
  }
});

app.post("/api/analyze-stems", upload.fields([
  { name: "voice", maxCount: 1 },
  { name: "instrumental", maxCount: 1 }
]), async (req, res) => {
  let voicePath = "";
  let instrumentalPath = "";

  try {
    const voice = req.files?.voice?.[0];
    const instrumental = req.files?.instrumental?.[0];

    if (!voice || !instrumental) {
      return res.status(400).json({
        ok: false,
        error: "Les fichiers voix et instrumental sont obligatoires"
      });
    }

    const voiceExt = path.extname(voice.originalname || "") || ".wav";
    const instrumentalExt = path.extname(instrumental.originalname || "") || ".wav";

    voicePath = makeTempFilePath(voiceExt);
    instrumentalPath = makeTempFilePath(instrumentalExt);

    await fs.writeFile(voicePath, voice.buffer);
    await fs.writeFile(instrumentalPath, instrumental.buffer);

    const voiceAnalysis = await runPythonAnalyze(voicePath);
    const instrumentalAnalysis = await runPythonAnalyze(instrumentalPath);

    return res.json({
      ok: true,
      mode: "stems",
      voice: {
        fileName: voice.originalname,
        size: voice.size,
        analysis: voiceAnalysis
      },
      instrumental: {
        fileName: instrumental.originalname,
        size: instrumental.size,
        analysis: instrumentalAnalysis
      }
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  } finally {
    if (voicePath) {
      await fs.unlink(voicePath).catch(() => {});
    }
    if (instrumentalPath) {
      await fs.unlink(instrumentalPath).catch(() => {});
    }
  }
});

app.post("/api/mastering-plan", async (req, res) => {
  try {
    const { userPrompt, analysis } = req.body;
    const plan = await buildPlanWithAI(userPrompt, analysis);

    return res.json({
      ok: true,
      result: JSON.stringify(plan, null, 2),
      plan
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

    const userPrompt = req.body.userPrompt || "Rends ce son plus beau puis masterise-le";
    const analysis = req.body.analysis ? JSON.parse(req.body.analysis) : {};
    const plan = await buildPlanWithAI(userPrompt, analysis);
    const filterChain = buildFilterChainFromPlan(plan);

    const ext = path.extname(req.file.originalname || "") || ".wav";
    inputPath = makeTempFilePath(ext);
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
    res.setHeader("X-Mastering-Plan", encodeURIComponent(JSON.stringify(plan, null, 2)));

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
