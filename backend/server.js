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
import {
  listClientPaymentRequestsV2,
  listAdminPaymentRequestsV2,
  createPaymentRequestV2,
  approvePaymentRequestV2,
  cancelPaymentRequestV2
} from "./payments-v2.js";
import { buildInternalAssistantReplyV2 } from "./assistant-v2.js";
import { buildBusinessStatsV2 } from "./stats-v2.js";

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

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ADMIN_SECRET = process.env.ADMIN_SECRET || process.env.OPENAI_API_KEY || "change-admin-secret";
const CLIENT_SECRET = process.env.CLIENT_SECRET || ADMIN_SECRET;

const MONTHS_FR = [
  "janvier", "février", "mars",
  "avril", "mai", "juin",
  "juillet", "août", "septembre",
  "octobre", "novembre", "décembre"
];

const PACKS = {
  starter: {
    key: "starter",
    pack_name: "Découverte - 3 générations",
    amount_eur: 1.49,
    generations_to_add: 3,
    revolut_link: "https://checkout.revolut.com/pay/006cbbc6-4c6d-4a1d-b144-ecf15893b5f2"
  },
  creator: {
    key: "creator",
    pack_name: "Créateur - 10 générations",
    amount_eur: 3.99,
    generations_to_add: 10,
    revolut_link: "https://checkout.revolut.com/pay/baa247e6-1222-40ce-82d4-2e7ab7f342d9"
  },
  studio: {
    key: "studio",
    pack_name: "Studio - 25 générations",
    amount_eur: 7.99,
    generations_to_add: 25,
    revolut_link: "https://checkout.revolut.com/pay/e257b32c-3b50-443d-9e83-faf5fd6f2567"
  }
};

function getPackConfig(packKey) {
  return PACKS[String(packKey || "").trim()] || null;
}

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

function normalizeText(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeDateInput(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return value.trim();
  }

  const date = value ? new Date(value) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;

  const year = safeDate.getFullYear();
  const month = String(safeDate.getMonth() + 1).padStart(2, "0");
  const day = String(safeDate.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildPeriodInfo(dateInput) {
  const normalizedDate = normalizeDateInput(dateInput);
  const [year, month] = normalizedDate.split("-").map(Number);
  const monthNumber = clamp(month, 1, 12);
  const monthLabel = `${MONTHS_FR[monthNumber - 1]} ${year}`;
  const quarter = Math.floor((monthNumber - 1) / 3) + 1;
  const quarterLabel = `T${quarter} ${year}`;

  return {
    normalizedDate,
    year,
    monthNumber,
    monthLabel,
    quarter,
    quarterLabel
  };
}

function getCurrentQuarterYear() {
  const now = new Date();
  return {
    quarter: Math.floor(now.getMonth() / 3) + 1,
    year: now.getFullYear()
  };
}

function getQuarterMonths(quarter, year) {
  const safeQuarter = clamp(safeNumber(quarter, 1), 1, 4);
  const startMonth = (safeQuarter - 1) * 3 + 1;

  return [0, 1, 2].map((offset) => {
    const monthNumber = startMonth + offset;
    const monthName = MONTHS_FR[monthNumber - 1];
    return {
      monthNumber,
      monthName,
      monthLabel: `${monthName} ${year}`
    };
  });
}

function formatEuroText(value) {
  const num = Number(safeNumber(value, 0).toFixed(2));
  if (Number.isInteger(num)) {
    return `${num} €`;
  }
  return `${num.toFixed(2).replace(".", ",")} €`;
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

function hashPassword(password, existingSalt = "") {
  const salt = existingSalt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  if (!password || !salt || !expectedHash) return false;
  const computed = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(expectedHash, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function createSignedToken(secret, type, payload) {
  const body = {
    type,
    exp: Date.now() + 1000 * 60 * 60 * 24 * 7,
    ...payload
  };

  const encoded = Buffer.from(JSON.stringify(body)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(encoded)
    .digest("base64url");

  return `${encoded}.${signature}`;
}

function verifySignedToken(secret, token, expectedType) {
  if (!token || typeof token !== "string" || !token.includes(".")) {
    throw new Error("Token invalide");
  }

  const [encoded, signature] = token.split(".");
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(encoded)
    .digest("base64url");

  if (signature !== expectedSignature) {
    throw new Error("Signature invalide");
  }

  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));

  if (!payload?.exp || !payload?.type) {
    throw new Error("Session invalide");
  }

  if (payload.type !== expectedType) {
    throw new Error("Type de session invalide");
  }

  if (Date.now() > payload.exp) {
    throw new Error("Session expirée");
  }

  return payload;
}

function readBearerToken(req) {
  const authorization = req.headers.authorization || "";
  if (!authorization.startsWith("Bearer ")) return "";
  return authorization.slice(7).trim();
}

function readAdminBypassToken(req) {
  const header = req.headers["x-admin-authorization"] || "";
  const value = Array.isArray(header) ? header[0] : header;
  if (!value.startsWith("Bearer ")) return "";
  return value.slice(7).trim();
}

function requireAdmin(req, res, next) {
  try {
    const token = readBearerToken(req);
    const payload = verifySignedToken(ADMIN_SECRET, token, "admin");
    req.admin = payload;
    next();
  } catch (error) {
    return res.status(401).json({
      ok: false,
      error: error.message || "Accès admin refusé"
    });
  }
}

function requireClient(req, res, next) {
  try {
    const token = readBearerToken(req);
    const payload = verifySignedToken(CLIENT_SECRET, token, "client");
    req.client = payload;
    next();
  } catch (error) {
    return res.status(401).json({
      ok: false,
      error: error.message || "Connexion client requise"
    });
  }
}

async function getUserByEmail(email) {
  const { data, error } = await supabase
    .from("app_users")
    .select("*")
    .eq("email", email)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data || null;
}

async function getUserById(id) {
  const { data, error } = await supabase
    .from("app_users")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data || null;
}

async function listUsers() {
  const { data, error } = await supabase
    .from("app_users")
    .select("id,email,current_generations,created_at")
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return Array.isArray(data) ? data : [];
}

async function updateUserGenerations(userId, nextGenerations) {
  const { data, error } = await supabase
    .from("app_users")
    .update({ current_generations: nextGenerations })
    .eq("id", userId)
    .select("id,email,current_generations,created_at")
    .single();

  if (error) throw new Error(error.message);
  return data;
}

async function insertGenerationEvent({ userId, delta, reason, note }) {
  const { error } = await supabase
    .from("app_generation_events")
    .insert([{
      user_id: userId,
      delta,
      reason,
      note: note || ""
    }]);

  if (error) throw new Error(error.message);
}

function buildHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function resolveProcessingContext(req) {
  const adminToken = readAdminBypassToken(req);

  if (adminToken) {
    try {
      verifySignedToken(ADMIN_SECRET, adminToken, "admin");
      return { adminBypass: true, clientUser: null };
    } catch (error) {
      throw buildHttpError(401, error.message || "Accès admin refusé");
    }
  }

  let clientPayload;
  try {
    clientPayload = verifySignedToken(CLIENT_SECRET, readBearerToken(req), "client");
  } catch (error) {
    throw buildHttpError(401, error.message || "Connexion client requise");
  }

  const clientUser = await getUserById(clientPayload.userId);

  if (!clientUser) {
    throw buildHttpError(404, "Compte client introuvable");
  }

  if (safeNumber(clientUser.current_generations, 0) < 1) {
    throw buildHttpError(403, "Tu n’as plus assez de générations");
  }

  return { adminBypass: false, clientUser };
}

async function consumeProcessingGeneration(clientUser, note = "1 génération utilisée pour un traitement final") {
  const currentBalance = safeNumber(clientUser.current_generations, 0);
  const nextBalance = Math.max(0, currentBalance - 1);

  await updateUserGenerations(clientUser.id, nextBalance);
  await insertGenerationEvent({
    userId: clientUser.id,
    delta: -1,
    reason: "final_master",
    note
  });

  return nextBalance;
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
          makeup_gain_db: 1
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
  const instrumentalPlan = safePlan.instrumentalPlan && typeof safePlan.instrumentalPlan === "object" ? safePlan.instrumentalPlan : {};
  const recombinationPlan = safePlan.recombinationPlan && typeof safePlan.recombinationPlan === "object" ? safePlan.recombinationPlan : {};

  return {
    mode: "stems",
    strategy: typeof safePlan.strategy === "string" ? safePlan.strategy : fallback.strategy,
    finalObjective: typeof safePlan.finalObjective === "string" ? safePlan.finalObjective : fallback.finalObjective,
    finalMasterIntent: typeof safePlan.finalMasterIntent === "string" ? safePlan.finalMasterIntent : fallback.finalMasterIntent,
    voicePlan: {
      goal: typeof voicePlan.goal === "string" ? voicePlan.goal : fallback.voicePlan.goal,
      intensity: clamp(safeNumber(voicePlan.intensity, fallback.voicePlan.intensity), 0, 1),
      actions: Array.isArray(voicePlan.actions) && voicePlan.actions.length ? voicePlan.actions.map(String) : fallback.voicePlan.actions,
      settings: {
        presence_gain_db: clamp(safeNumber(voicePlan.settings?.presence_gain_db, fallback.voicePlan.settings.presence_gain_db), -6, 6),
        air_gain_db: clamp(safeNumber(voicePlan.settings?.air_gain_db, fallback.voicePlan.settings.air_gain_db), -6, 6),
        compression_ratio: clamp(safeNumber(voicePlan.settings?.compression_ratio, fallback.voicePlan.settings.compression_ratio), 1.1, 6),
        compression_attack_ms: clamp(safeNumber(voicePlan.settings?.compression_attack_ms, fallback.voicePlan.settings.compression_attack_ms), 1, 200),
        compression_release_ms: clamp(safeNumber(voicePlan.settings?.compression_release_ms, fallback.voicePlan.settings.compression_release_ms), 20, 1000)
      }
    },
    instrumentalPlan: {
      goal: typeof instrumentalPlan.goal === "string" ? instrumentalPlan.goal : fallback.instrumentalPlan.goal,
      intensity: clamp(safeNumber(instrumentalPlan.intensity, fallback.instrumentalPlan.intensity), 0, 1),
      actions: Array.isArray(instrumentalPlan.actions) && instrumentalPlan.actions.length ? instrumentalPlan.actions.map(String) : fallback.instrumentalPlan.actions,
      settings: {
        low_gain_db: clamp(safeNumber(instrumentalPlan.settings?.low_gain_db, fallback.instrumentalPlan.settings.low_gain_db), -6, 6),
        presence_gain_db: clamp(safeNumber(instrumentalPlan.settings?.presence_gain_db, fallback.instrumentalPlan.settings.presence_gain_db), -6, 6),
        glue_ratio: clamp(safeNumber(instrumentalPlan.settings?.glue_ratio, fallback.instrumentalPlan.settings.glue_ratio), 1.1, 6),
        glue_attack_ms: clamp(safeNumber(instrumentalPlan.settings?.glue_attack_ms, fallback.instrumentalPlan.settings.glue_attack_ms), 1, 200),
        glue_release_ms: clamp(safeNumber(instrumentalPlan.settings?.glue_release_ms, fallback.instrumentalPlan.settings.glue_release_ms), 20, 1200)
      }
    },
    recombinationPlan: {
      voiceLevelDb: clamp(safeNumber(recombinationPlan.voiceLevelDb, fallback.recombinationPlan.voiceLevelDb), -12, 12),
      instrumentalLevelDb: clamp(safeNumber(recombinationPlan.instrumentalLevelDb, fallback.recombinationPlan.instrumentalLevelDb), -12, 12),
      notes: Array.isArray(recombinationPlan.notes) && recombinationPlan.notes.length ? recombinationPlan.notes.map(String) : fallback.recombinationPlan.notes
    }
  };
}

async function buildPlanWithAI(userPrompt, analysis) {
  const systemPrompt = `
Tu es un ingénieur du son expert.
Tu dois embellir le morceau AVANT le final master.
Tu réponds uniquement avec un JSON valide.
Aucun texte avant.
Aucun texte après.
Aucun markdown.
`.trim();

  const userMessage = `
Demande utilisateur :
${userPrompt || "Rends ce son plus beau puis applique un final master propre"}

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
${userPrompt || "Rends ce son plus beau puis applique un final master propre"}

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
  const makeupGainDb = clamp(safeNumber(settings.makeup_gain_db, 1), 1, 8);

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
        const makeupGainDb = clamp(safeNumber(settings.makeup_gain_db, 1.2), 1, 8);

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
  const filters = ["highpass=f=70"];

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
    `acompressor=threshold=-19dB:ratio=${s.glue_ratio}:attack=${s.glue_attack_ms}:release=${s.glue_release_ms}:makeup=1`
  );

  return filters.join(",");
}

async function buildQuarterData(quarterInput, yearInput) {
  const current = getCurrentQuarterYear();
  const quarter = clamp(safeNumber(quarterInput, current.quarter), 1, 4);
  const year = clamp(safeNumber(yearInput, current.year), 2020, 2100);

  const { data: sales, error: salesError } = await supabase
    .from("admin_sales")
    .select("*")
    .eq("quarter", quarter)
    .eq("year", year)
    .order("sale_date", { ascending: false });

  if (salesError) throw new Error(`Erreur ventes : ${salesError.message}`);

  const { data: expenses, error: expensesError } = await supabase
    .from("admin_expenses")
    .select("*")
    .eq("quarter", quarter)
    .eq("year", year)
    .order("expense_date", { ascending: false });

  if (expensesError) throw new Error(`Erreur dépenses : ${expensesError.message}`);

  const safeSales = Array.isArray(sales) ? sales : [];
  const safeExpenses = Array.isArray(expenses) ? expenses : [];
  const quarterMonths = getQuarterMonths(quarter, year);

  const monthlyTotals = new Map(quarterMonths.map((item) => [item.monthNumber, 0]));
  safeSales.forEach((row) => {
    const currentValue = monthlyTotals.get(row.month_number) || 0;
    monthlyTotals.set(row.month_number, currentValue + safeNumber(row.amount_eur, 0));
  });

  const monthlySales = quarterMonths.map((item) => ({
    monthNumber: item.monthNumber,
    monthName: item.monthName,
    monthLabel: item.monthLabel,
    totalEur: Number((monthlyTotals.get(item.monthNumber) || 0).toFixed(2))
  }));

  const salesTotalEur = Number(
    safeSales.reduce((sum, row) => sum + safeNumber(row.amount_eur, 0), 0).toFixed(2)
  );

  const expensesTotalEur = Number(
    safeExpenses.reduce((sum, row) => sum + safeNumber(row.amount_eur, 0), 0).toFixed(2)
  );

  const expenseGroupsMap = new Map();
  safeExpenses.forEach((row) => {
    const key = row.category || "Dépense";
    expenseGroupsMap.set(key, (expenseGroupsMap.get(key) || 0) + safeNumber(row.amount_eur, 0));
  });

  const expenseGroups = [...expenseGroupsMap.entries()].map(([category, total]) => ({
    category,
    totalEur: Number(total.toFixed(2))
  }));

  return {
    quarter,
    year,
    summary: {
      quarter,
      year,
      periodLabel: `${quarterMonths.map((item) => item.monthName).join(", ")} ${year}`,
      declarationTotalEur: salesTotalEur,
      expensesTotalEur,
      internalNetEur: Number((salesTotalEur - expensesTotalEur).toFixed(2)),
      monthlySales,
      expenseGroups
    },
    sales: safeSales,
    expenses: safeExpenses
  };
}

function buildFallbackQuarterReport(context) {
  const monthlyLines = context.summary.monthlySales
    .map((item) => `- ${item.monthName} : ${formatEuroText(item.totalEur)}`)
    .join("\n");

  const expenseLines = context.summary.expenseGroups.length
    ? context.summary.expenseGroups
        .map((item) => `- ${item.category} : ${formatEuroText(item.totalEur)}`)
        .join("\n")
    : "- aucune dépense interne";

  return [
    "Déclaration URSSAF",
    "",
    "Période :",
    context.summary.periodLabel,
    "",
    "Revenus :",
    monthlyLines,
    "",
    "Total à déclarer :",
    formatEuroText(context.summary.declarationTotalEur),
    "",
    "Dépenses internes :",
    expenseLines,
    "",
    "Total dépenses internes :",
    formatEuroText(context.summary.expensesTotalEur),
    "",
    "Marge interne indicative :",
    formatEuroText(context.summary.internalNetEur)
  ].join("\n");
}

async function buildQuarterReportWithAI(context) {
  const fallbackReport = buildFallbackQuarterReport(context);

  const systemPrompt = `
Tu es l'assistant comptable caché d'une micro-entreprise française.
Tu dois rédiger un rapport trimestriel simple et clair.
Tu respectes STRICTEMENT le format suivant :

Déclaration URSSAF

Période :
avril, mai, juin 2026

Revenus :
- avril : 10 €
- mai : 109 €
- juin : 5 €

Total à déclarer :
124 €

Dépenses internes :
- OpenAI : 10 €
- Render : 7 €

Total dépenses internes :
17 €

Marge interne indicative :
107 €

Tu gardes les mois en français.
Tu ne rajoutes aucun titre supplémentaire.
Tu n'ajoutes aucun commentaire après.
`.trim();

  const userPrompt = `
Période :
${context.summary.periodLabel}

Revenus mensuels :
${JSON.stringify(context.summary.monthlySales, null, 2)}

Total à déclarer :
${context.summary.declarationTotalEur}

Dépenses internes par catégorie :
${JSON.stringify(context.summary.expenseGroups, null, 2)}

Total dépenses internes :
${context.summary.expensesTotalEur}

Marge interne indicative :
${context.summary.internalNetEur}
`.trim();

  try {
    const response = await openai.responses.create({
      model: "gpt-5.4",
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    });

    const output = (response.output_text || "").trim();
    return output || fallbackReport;
  } catch {
    return fallbackReport;
  }
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

app.post("/api/client/register", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password || "";

    if (!email || !password) {
      return res.status(400).json({
        ok: false,
        error: "Email et mot de passe obligatoires"
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        ok: false,
        error: "Mot de passe trop court"
      });
    }

    const existingUser = await getUserByEmail(email);
    if (existingUser) {
      return res.status(409).json({
        ok: false,
        error: "Cet email existe déjà"
      });
    }

    const { salt, hash } = hashPassword(password);

    const { data, error } = await supabase
      .from("app_users")
      .insert([{
        email,
        password_salt: salt,
        password_hash: hash,
        current_generations: 0
      }])
      .select("id,email,current_generations,created_at")
      .single();

    if (error) throw new Error(error.message);

    const token = createSignedToken(CLIENT_SECRET, "client", {
      userId: data.id,
      email: data.email
    });

    return res.json({
      ok: true,
      token,
      user: {
        id: data.id,
        email: data.email,
        currentGenerations: data.current_generations,
        createdAt: data.created_at
      }
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Inscription impossible"
    });
  }
});

app.post("/api/client/login", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password || "";

    if (!email || !password) {
      return res.status(400).json({
        ok: false,
        error: "Email et mot de passe obligatoires"
      });
    }

    const user = await getUserByEmail(email);
    if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
      return res.status(401).json({
        ok: false,
        error: "Identifiants invalides"
      });
    }

    const token = createSignedToken(CLIENT_SECRET, "client", {
      userId: user.id,
      email: user.email
    });

    return res.json({
      ok: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        currentGenerations: user.current_generations,
        createdAt: user.created_at
      }
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Connexion impossible"
    });
  }
});

app.get("/api/client/me", requireClient, async (req, res) => {
  try {
    const user = await getUserById(req.client.userId);

    if (!user) {
      return res.status(404).json({
        ok: false,
        error: "Compte client introuvable"
      });
    }

    return res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        currentGenerations: user.current_generations,
        createdAt: user.created_at
      }
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Lecture client impossible"
    });
  }
});

app.get("/api/client/payment-requests", requireClient, async (req, res) => {
  try {
    const rows = await listClientPaymentRequestsV2({
      supabase,
      email: req.client.email
    });

    return res.json({ ok: true, requests: rows });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Lecture des demandes impossible"
    });
  }
});

app.post("/api/client/payment-requests", requireClient, async (req, res) => {
  try {
    const clientUser = await getUserById(req.client.userId);

    if (!clientUser) {
      return res.status(404).json({
        ok: false,
        error: "Compte client introuvable"
      });
    }

    const paymentRequest = await createPaymentRequestV2({
      supabase,
      clientUser,
      packKey: req.body?.packKey,
      clientNote: req.body?.clientNote,
      getPackConfig,
      buildHttpError,
      normalizeText
    });

    return res.json({
      ok: true,
      paymentRequest
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      ok: false,
      error: error.message || "Création de la demande impossible"
    });
  }
});

app.post("/api/admin/login", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password || "";

    if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
      return res.status(500).json({
        ok: false,
        error: "Variables admin manquantes sur le serveur"
      });
    }

    if (!email || !password) {
      return res.status(400).json({
        ok: false,
        error: "Email et mot de passe obligatoires"
      });
    }

    if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
      return res.status(401).json({
        ok: false,
        error: "Identifiants admin invalides"
      });
    }

    const token = createSignedToken(ADMIN_SECRET, "admin", { email });

    return res.json({
      ok: true,
      email,
      token
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Connexion admin impossible"
    });
  }
});

app.get("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    const users = await listUsers();
    return res.json({ ok: true, users });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Lecture utilisateurs impossible"
    });
  }
});

app.get("/api/admin/business-stats", requireAdmin, async (req, res) => {
  try {
    const current = getCurrentQuarterYear();

    const stats = await buildBusinessStatsV2({
      supabase,
      quarterInput: req.query.quarter || current.quarter,
      yearInput: req.query.year || current.year,
      safeNumber,
      clamp,
      getCurrentQuarterYear,
      getQuarterMonths
    });

    return res.json({
      ok: true,
      stats
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Chargement des statistiques impossible"
    });
  }
});

app.post("/api/admin/users/add-generations", requireAdmin, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const generations = Math.max(0, Math.round(safeNumber(req.body?.generations, 0)));
    const note = normalizeText(req.body?.note, "");

    if (!email || generations <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Email et nombre de générations obligatoires"
      });
    }

    const user = await getUserByEmail(email);
    if (!user) {
      return res.status(404).json({
        ok: false,
        error: "Client introuvable"
      });
    }

    const nextBalance = Math.max(0, safeNumber(user.current_generations, 0) + generations);
    const updatedUser = await updateUserGenerations(user.id, nextBalance);

    await insertGenerationEvent({
      userId: user.id,
      delta: generations,
      reason: "admin_add",
      note
    });

    return res.json({
      ok: true,
      user: updatedUser
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Ajout générations impossible"
    });
  }
});

app.get("/api/admin/dashboard", requireAdmin, async (req, res) => {
  try {
    const current = getCurrentQuarterYear();
    const quarter = req.query.quarter || current.quarter;
    const year = req.query.year || current.year;

    const context = await buildQuarterData(quarter, year);
    const reportText = await buildQuarterReportWithAI(context);

    return res.json({
      ok: true,
      ...context,
      reportText
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Chargement admin impossible"
    });
  }
});

app.get("/api/admin/payment-requests", requireAdmin, async (req, res) => {
  try {
    const rows = await listAdminPaymentRequestsV2({ supabase });

    return res.json({
      ok: true,
      pending: rows.pending,
      recent: rows.recent
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Lecture des paiements impossible"
    });
  }
});

app.post("/api/admin/payment-requests/:id/approve", requireAdmin, async (req, res) => {
  try {
    const result = await approvePaymentRequestV2({
      supabase,
      paymentRequestId: req.params.id,
      adminEmail: req.admin.email,
      adminNote: req.body?.adminNote,
      buildHttpError,
      normalizeText,
      normalizeEmail,
      safeNumber,
      getUserById,
      getUserByEmail,
      updateUserGenerations,
      insertGenerationEvent,
      normalizeDateInput,
      buildPeriodInfo
    });

    return res.json({
      ok: true,
      ...result
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      ok: false,
      error: error.message || "Validation impossible"
    });
  }
});

app.post("/api/admin/payment-requests/:id/cancel", requireAdmin, async (req, res) => {
  try {
    const paymentRequest = await cancelPaymentRequestV2({
      supabase,
      paymentRequestId: req.params.id,
      adminEmail: req.admin.email,
      adminNote: req.body?.adminNote,
      buildHttpError,
      normalizeText,
      normalizeEmail
    });

    return res.json({
      ok: true,
      paymentRequest
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      ok: false,
      error: error.message || "Annulation impossible"
    });
  }
});

app.post("/api/admin/internal-assistant", requireAdmin, async (req, res) => {
  try {
    const result = await buildInternalAssistantReplyV2({
      openai,
      payload: {
        clientEmail: normalizeEmail(req.body?.clientEmail || ""),
        clientMessage: normalizeText(req.body?.clientMessage, ""),
        packName: normalizeText(req.body?.packName, ""),
        paymentStatus: normalizeText(req.body?.paymentStatus, ""),
        appArea: normalizeText(req.body?.appArea, "support")
      },
      normalizeText,
      normalizeEmail
    });

    return res.json({
      ok: true,
      result
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Assistant interne indisponible"
    });
  }
});

app.post("/api/admin/sales", requireAdmin, async (req, res) => {
  try {
    const saleDate = normalizeDateInput(req.body?.saleDate);
    const customerName = normalizeText(req.body?.customerName, "Client non précisé");
    const packName = normalizeText(req.body?.packName, "Pack non précisé");
    const amountEur = safeNumber(req.body?.amountEur, NaN);
    const generationsAdded = Math.max(0, Math.round(safeNumber(req.body?.generationsAdded, 0)));
    const paymentMethod = normalizeText(req.body?.paymentMethod, "Paiement non précisé");
    const note = normalizeText(req.body?.note, "");

    if (!Number.isFinite(amountEur) || amountEur <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Montant de vente invalide"
      });
    }

    const period = buildPeriodInfo(saleDate);

    const { data, error } = await supabase
      .from("admin_sales")
      .insert([{
        sale_date: period.normalizedDate,
        year: period.year,
        quarter: period.quarter,
        quarter_label: period.quarterLabel,
        month_number: period.monthNumber,
        month_label: period.monthLabel,
        customer_name: customerName,
        pack_name: packName,
        amount_eur: Number(amountEur.toFixed(2)),
        generations_added: generationsAdded,
        payment_method: paymentMethod,
        note
      }])
      .select();

    if (error) throw new Error(error.message);

    return res.json({
      ok: true,
      data
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Enregistrement vente impossible"
    });
  }
});

app.post("/api/admin/expenses", requireAdmin, async (req, res) => {
  try {
    const expenseDate = normalizeDateInput(req.body?.expenseDate);
    const category = normalizeText(req.body?.category, "Dépense");
    const amountEur = safeNumber(req.body?.amountEur, NaN);
    const vendorName = normalizeText(req.body?.vendorName, "Fournisseur non précisé");
    const note = normalizeText(req.body?.note, "");

    if (!Number.isFinite(amountEur) || amountEur <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Montant de dépense invalide"
      });
    }

    const period = buildPeriodInfo(expenseDate);

    const { data, error } = await supabase
      .from("admin_expenses")
      .insert([{
        expense_date: period.normalizedDate,
        year: period.year,
        quarter: period.quarter,
        quarter_label: period.quarterLabel,
        month_number: period.monthNumber,
        month_label: period.monthLabel,
        category,
        amount_eur: Number(amountEur.toFixed(2)),
        vendor_name: vendorName,
        note
      }])
      .select();

    if (error) throw new Error(error.message);

    return res.json({
      ok: true,
      data
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Enregistrement dépense impossible"
    });
  }
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
    const { adminBypass, clientUser } = await resolveProcessingContext(req);

    if (!req.file) {
      return res.status(400).json({ ok: false, error: "Aucun fichier audio reçu" });
    }

    const userPrompt = req.body.userPrompt || "Rends ce son plus beau puis applique un final master";
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

    if (!adminBypass && clientUser) {
      const nextBalance = await consumeProcessingGeneration(
        clientUser,
        "1 génération utilisée pour un traitement fichier entier"
      );
      res.setHeader("X-Remaining-Generations", String(nextBalance));
    }

    if (adminBypass) {
      res.setHeader("X-Admin-Mode", "1");
    }

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
    return res.status(error.status || 500).json({ ok: false, error: error.message });
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
    const { adminBypass, clientUser } = await resolveProcessingContext(req);

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

    if (!adminBypass && clientUser) {
      const nextBalance = await consumeProcessingGeneration(
        clientUser,
        "1 génération utilisée pour un traitement voix + instrumental"
      );
      res.setHeader("X-Remaining-Generations", String(nextBalance));
    }

    if (adminBypass) {
      res.setHeader("X-Admin-Mode", "1");
    }

    const outputBuffer = await fs.readFile(mixPath);

    res.setHeader("Content-Type", "audio/wav");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="stems_master_final.wav"'
    );
    res.setHeader("X-Stem-Plan", encodeURIComponent(JSON.stringify(stemPlan, null, 2)));

    return res.send(outputBuffer);
  } catch (error) {
    return res.status(error.status || 500).json({ ok: false, error: error.message });
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
