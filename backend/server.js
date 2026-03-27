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

function dbToLinear(db) {
  return Math.pow(10, db / 20);
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

function getDefaultStemPlan() {
  return {
    mode: "stems",
    strategy: "Traiter séparément la voix et l'instrumental puis recombiner proprement avant le mastering final.",
    finalObjective: "Obtenir un rendu propre, puissant, équilibré et professionnel avec une voix lisible et un instrumental maîtrisé.",
    finalMasterIntent: "Après traitement séparé, recoller puis appliquer un mastering global léger et contrôlé.",
    voicePlan: {
      goal: "Mettre la voix en avant sans agressivité.",
      intensity: 0.45,
      actions: [
        "améliorer légèrement la présence",
        "ajouter un peu d’air si utile",
        "contrôler la dynamique sans écraser",
        "préserver l’intelligibilité"
      ],
      settings: {
        presence_gain_db: 1.0,
        air_gain_db: 0.5,
        compression_ratio: 1.8,
        compression_attack_ms: 20,
        compression_release_ms: 140
      }
    },
    instrumentalPlan: {
      goal: "Nettoyer et renforcer légèrement l’instrumental.",
      intensity: 0.45,
      actions: [
        "renforcer légèrement le corps",
        "contrôler le bas si nécessaire",
        "préserver la dynamique utile",
        "garder un espace pour la voix"
      ],
      settings: {
        low_gain_db: 0.8,
        presence_gain_db: 0.2,
        glue_ratio: 1.5,
        glue_attack_ms: 30,
        glue_release_ms: 220
      }
    },
    recombinationPlan: {
      voiceLevelDb: 0,
      instrumentalLevelDb: 0,
      notes: [
        "garder la voix bien lisible devant l’instrumental",
        "éviter l’écrasement du centre",
        "préparer une recombinaison propre avant mastering final"
      ]
    }
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

function normalizeStemPlan(plan) {
  const fallback = getDefaultStemPlan();
  const safePlan = plan && typeof plan === "object" ? plan : {};

  const voicePlan = safePlan.voicePlan && typeof safePlan.voicePlan === "object" ? safePlan.voicePlan : {};
  const instrumentalPlan =
    safePlan.instrumentalPlan && typeof safePlan.instrumentalPlan === "object"
      ? safePlan.instrumentalPlan
      : {};
  const recombinationPlan =
    safePlan.recombinationPlan && typeof safePlan.recombinationPlan === "object"
      ? safePlan.recombinationPlan
      : {};

  return {
    mode: "stems",
    strategy: typeof safePlan.strategy === "string" ? safePlan.strategy : fallback.strategy,
    finalObjective:
      typeof safePlan.finalObjective === "string"
        ? safePlan.finalObjective
        : fallback.finalObjective,
    finalMasterIntent:
      typeof safePlan.finalMasterIntent === "string"
        ? safePlan.finalMasterIntent
        : fallback.finalMasterIntent,
    voicePlan: {
      goal: typeof voicePlan.goal === "string" ? voicePlan.goal : fallback.voicePlan.goal,
      intensity: clamp(safeNumber(voicePlan.intensity, fallback.voicePlan.intensity), 0, 1),
      actions: Array.isArray(voicePlan.actions) && voicePlan.actions.length
        ? voicePlan.actions.map(String)
        : fallback.voicePlan.actions,
      settings: {
        presence_gain_db: clamp(
          safeNumber(voicePlan.settings?.presence_gain_db, fallback.voicePlan.settings.presence_gain_db),
          -6,
          6
        ),
        air_gain_db: clamp(
          safeNumber(voicePlan.settings?.air_gain_db, fallback.voicePlan.settings.air_gain_db),
          -6,
          6
        ),
        compression_ratio: clamp(
          safeNumber(voicePlan.settings?.compression_ratio, fallback.voicePlan.settings.compression_ratio),
          1.1,
          6
        ),
        compression_attack_ms: clamp(
          safeNumber(voicePlan.settings?.compression_attack_ms, fallback.voicePlan.settings.compression_attack_ms),
          1,
          200
        ),
        compression_release_ms: clamp(
          safeNumber(voicePlan.settings?.compression_release_ms, fallback.voicePlan.settings.compression_release_ms),
          20,
          1000
        )
      }
    },
    instrumentalPlan: {
      goal:
        typeof instrumentalPlan.goal === "string"
          ? instrumentalPlan.goal
          : fallback.instrumentalPlan.goal,
      intensity: clamp(
        safeNumber(instrumentalPlan.intensity, fallback.instrumentalPlan.intensity),
        0,
        1
      ),
      actions: Array.isArray(instrumentalPlan.actions) && instrumentalPlan.actions.length
        ? instrumentalPlan.actions.map(String)
        : fallback.instrumentalPlan.actions,
      settings: {
        low_gain_db: clamp(
          safeNumber(instrumentalPlan.settings?.low_gain_db, fallback.instrumentalPlan.settings.low_gain_db),
          -6,
          6
        ),
        presence_gain_db: clamp(
          safeNumber(instrumentalPlan.settings?.presence_gain_db, fallback.instrumentalPlan.settings.presence_gain_db),
          -6,
          6
        ),
        glue_ratio: clamp(
          safeNumber(instrumentalPlan.settings?.glue_ratio, fallback.instrumentalPlan.settings.glue_ratio),
          1.1,
          6
        ),
        glue_attack_ms: clamp(
          safeNumber(instrumentalPlan.settings?.glue_attack_ms, fallback.instrumentalPlan.settings.glue_attack_ms),
          1,
          200
        ),
        glue_release_ms: clamp(
          safeNumber(instrumentalPlan.settings?.glue_release_ms, fallback.instrumentalPlan.settings.glue_release_ms),
          20,
          1200
        )
      }
    },
    recombinationPlan: {
      voiceLevelDb: clamp(
        safeNumber(recombinationPlan.voiceLevelDb, fallback.recombinationPlan.voiceLevelDb),
        -12,
        12
      ),
      instrumentalLevelDb: clamp(
        safeNumber(recombinationPlan.instrumentalLevelDb, fallback.recombinationPlan.instrumentalLevelDb),
        -12,
        12
      ),
      notes: Array.isArray(recombinationPlan.notes) && recombinationPlan.notes.length
        ? recombinationPlan.notes.map(String)
        : fallback.recombinationPlan.notes
    }
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

async function buildStemPlanWithAI(userPrompt, voiceAnalysis, instrumentalAnalysis) {
  const systemPrompt = `
Tu es un ingénieur du son expert.
Tu reçois une analyse séparée de la voix et de l'instrumental.
Tu dois construire un plan de traitement séparé.
Tu réponds uniquement avec un JSON valide.
Aucun texte avant.
Aucun texte après.
Aucun markdown.

Format obligatoire :
{
  "strategy": "string",
  "finalObjective": "string",
  "finalMasterIntent": "string",
  "voicePlan": {
    "goal": "string",
    "intensity": 0.45,
    "actions": ["string", "string"],
    "settings": {
      "presence_gain_db": 1.0,
      "air_gain_db": 0.5,
      "compression_ratio": 1.8,
      "compression_attack_ms": 20,
      "compression_release_ms": 140
    }
  },
  "instrumentalPlan": {
    "goal": "string",
    "intensity": 0.45,
    "actions": ["string", "string"],
    "settings": {
      "low_gain_db": 0.8,
      "presence_gain_db": 0.2,
      "glue_ratio": 1.5,
      "glue_attack_ms": 30,
      "glue_release_ms": 220
    }
  },
  "recombinationPlan": {
    "voiceLevelDb": 0,
    "instrumentalLevelDb": 0,
    "notes": ["string", "string"]
  }
}
`.trim();

  const userMessage = `
Demande utilisateur :
${userPrompt || "Rends ce son plus beau puis masterise-le proprement"}

Analyse voix :
${JSON.stringify(voiceAnalysis || {}, null, 2)}

Analyse instrumental :
${JSON.stringify(instrumentalAnalysis || {}, null, 2)}
`.trim();

  const response = await openai.responses.create({
    model: "gpt-5.4",
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage }
    ]
  });

  const parsed = extractJson(response.output_text || "");
  return normalizeStemPlan(parsed);
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

function buildVoiceStemFilters(stemPlan) {
  const s = stemPlan.voicePlan.settings;
  const filters = [
    "highpass=f=70"
  ];

  if (s.presence_gain_db !== 0) {
    filters.push(`equalizer=f=3200:t=q:w=1.0:g=${s.presence_gain_db}`);
  }
  if (s.air_gain_db !== 0) {
    filters.push(`equalizer=f=9500:t=q:w=0.8:g=${s.air_gain_db}`);
  }

  filters.push(
    `acompressor=threshold=-18dB:ratio=${s.compression_ratio}:attack=${s.compression_attack_ms}:release=${s.compression_release_ms}:makeup=1`
  );

  return filters.join(",");
}

function buildInstrumentalStemFilters(stemPlan) {
  const s = stemPlan.instrumentalPlan.settings;
  const filters = [];

  if (s.low_gain_db !== 0) {
    filters.push(`equalizer=f=95:t=q:w=1.1:g=${s.low_gain_db}`);
  }
  if (s.presence_gain_db !== 0) {
    filters.push(`equalizer=f=3200:t=q:w=1.0:g=${s.presence_gain_db}`);
  }

  filters.push(
    `acompressor=threshold=-19dB:ratio=${s.glue_ratio}:attack=${s.glue_attack_ms}:release=${s.glue_release_ms}:makeup=0.8`
  );

  return filters.join(",");
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
      return res.status(400).json({ ok: false, error: "Aucun fichier audio reçu" });
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
    return res.status(500).json({ ok: false, error: error.message });
  } finally {
    if (inputPath) await fs.unlink(inputPath).catch(() => {});
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
    return res.status(500).json({ ok: false, error: error.message });
  } finally {
    if (voicePath) await fs.unlink(voicePath).catch(() => {});
    if (instrumentalPath) await fs.unlink(instrumentalPath).catch(() => {});
  }
});

app.post("/api/plan-stems", async (req, res) => {
  try {
    const { userPrompt, voiceAnalysis, instrumentalAnalysis } = req.body;

    if (!voiceAnalysis || !instrumentalAnalysis) {
      return res.status(400).json({
        ok: false,
        error: "voiceAnalysis et instrumentalAnalysis sont obligatoires"
      });
    }

    const plan = await buildStemPlanWithAI(
      userPrompt,
      voiceAnalysis,
      instrumentalAnalysis
    );

    return res.json({
      ok: true,
      mode: "stems",
      plan,
      result: JSON.stringify(plan, null, 2)
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
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
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/master", upload.single("audio"), async (req, res) => {
  let inputPath = "";
  let outputPath = "";

  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "Aucun fichier audio reçu" });
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
    return res.status(500).json({ ok: false, error: error.message });
  } finally {
    if (inputPath) await fs.unlink(inputPath).catch(() => {});
    if (outputPath) await fs.unlink(outputPath).catch(() => {});
  }
});

app.post("/api/master-stems", upload.fields([
  { name: "voice", maxCount: 1 },
  { name: "instrumental", maxCount: 1 }
]), async (req, res) => {
  let voiceInputPath = "";
  let instrumentalInputPath = "";
  let voiceProcessedPath = "";
  let instrumentalProcessedPath = "";
  let mixPath = "";

  try {
    const voice = req.files?.voice?.[0];
    const instrumental = req.files?.instrumental?.[0];

    if (!voice || !instrumental) {
      return res.status(400).json({
        ok: false,
        error: "Les fichiers voix et instrumental sont obligatoires"
      });
    }

    const stemPlan = normalizeStemPlan(
      req.body.stemPlan ? JSON.parse(req.body.stemPlan) : getDefaultStemPlan()
    );

    const voiceExt = path.extname(voice.originalname || "") || ".wav";
    const instrumentalExt = path.extname(instrumental.originalname || "") || ".wav";

    voiceInputPath = makeTempFilePath(voiceExt);
    instrumentalInputPath = makeTempFilePath(instrumentalExt);
    voiceProcessedPath = makeTempFilePath(".wav");
    instrumentalProcessedPath = makeTempFilePath(".wav");
    mixPath = makeTempFilePath(".wav");

    await fs.writeFile(voiceInputPath, voice.buffer);
    await fs.writeFile(instrumentalInputPath, instrumental.buffer);

    const voiceFilters = buildVoiceStemFilters(stemPlan);
    const instrumentalFilters = buildInstrumentalStemFilters(stemPlan);

    await runFfmpeg([
      "-y",
      "-i",
      voiceInputPath,
      "-vn",
      "-af",
      voiceFilters,
      "-ar",
      "44100",
      "-ac",
      "2",
      "-c:a",
      "pcm_s16le",
      voiceProcessedPath
    ]);

    await runFfmpeg([
      "-y",
      "-i",
      instrumentalInputPath,
      "-vn",
      "-af",
      instrumentalFilters,
      "-ar",
      "44100",
      "-ac",
      "2",
      "-c:a",
      "pcm_s16le",
      instrumentalProcessedPath
    ]);

    const voiceGain = dbToLinear(stemPlan.recombinationPlan.voiceLevelDb);
    const instrumentalGain = dbToLinear(stemPlan.recombinationPlan.instrumentalLevelDb);

    await runFfmpeg([
      "-y",
      "-i",
      voiceProcessedPath,
      "-i",
      instrumentalProcessedPath,
      "-filter_complex",
      `[0:a]volume=${voiceGain.toFixed(4)}[v];[1:a]volume=${instrumentalGain.toFixed(4)}[m];[v][m]amix=inputs=2:normalize=0,alimiter=limit=0.8913,loudnorm=I=-14:TP=-1:LRA=11[aout]`,
      "-map",
      "[aout]",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-c:a",
      "pcm_s16le",
      mixPath
    ]);

    const outputBuffer = await fs.readFile(mixPath);

    res.setHeader("Content-Type", "audio/wav");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="stems_master_final.wav"'
    );
    res.setHeader("X-Stem-Plan", encodeURIComponent(JSON.stringify(stemPlan, null, 2)));

    return res.send(outputBuffer);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  } finally {
    for (const p of [
      voiceInputPath,
      instrumentalInputPath,
      voiceProcessedPath,
      instrumentalProcessedPath,
      mixPath
    ]) {
      if (p) await fs.unlink(p).catch(() => {});
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

    if (error) throw error;

    return res.json({ ok: true, data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Serveur démarré sur le port ${port}`);
});
