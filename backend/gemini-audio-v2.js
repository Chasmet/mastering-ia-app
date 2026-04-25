function cleanText(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function extractJsonLoose(text) {
  if (!text || typeof text !== "string") {
    throw new Error("Réponse Gemini vide");
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

  throw new Error("JSON Gemini introuvable");
}

function normalizeGeminiAudioResult(raw) {
  const result = raw && typeof raw === "object" ? raw : {};

  return {
    ok: true,
    provider: "gemini",
    model: cleanText(result.model, process.env.GEMINI_AUDIO_MODEL || "gemini-2.5-flash"),
    vocal_presence: cleanText(result.vocal_presence, "non déterminé"),
    vocal_clarity: cleanText(result.vocal_clarity, "non déterminé"),
    vocal_energy: cleanText(result.vocal_energy, "non déterminé"),
    emotion: cleanText(result.emotion, "non déterminé"),
    musical_style: cleanText(result.musical_style, "non déterminé"),
    perceived_mix: cleanText(result.perceived_mix, "non déterminé"),
    issues: Array.isArray(result.issues) ? result.issues.map(String).slice(0, 8) : [],
    recommendations: Array.isArray(result.recommendations) ? result.recommendations.map(String).slice(0, 8) : [],
    mastering_intent: cleanText(result.mastering_intent, "Mastering propre, clair et équilibré."),
    confidence: Number.isFinite(Number(result.confidence))
      ? Math.max(0, Math.min(1, Number(result.confidence)))
      : 0.65
  };
}

export function buildGeminiAudioFallback(reason = "Analyse Gemini indisponible") {
  return {
    ok: false,
    provider: "gemini",
    model: process.env.GEMINI_AUDIO_MODEL || "gemini-2.5-flash",
    vocal_presence: "non déterminé",
    vocal_clarity: "non déterminé",
    vocal_energy: "non déterminé",
    emotion: "non déterminé",
    musical_style: "non déterminé",
    perceived_mix: "non déterminé",
    issues: [],
    recommendations: [],
    mastering_intent: "Continuer avec l'analyse technique Python et appliquer un mastering propre.",
    confidence: 0,
    error: reason
  };
}

export async function analyzeAudioWithGemini({
  gemini,
  audioBuffer,
  mimeType = "audio/mpeg",
  userPrompt = "",
  technicalAnalysis = {}
}) {
  if (!gemini) {
    return buildGeminiAudioFallback("Client Gemini non initialisé");
  }

  if (!audioBuffer || !Buffer.isBuffer(audioBuffer)) {
    return buildGeminiAudioFallback("Fichier audio manquant");
  }

  const modelName = process.env.GEMINI_AUDIO_MODEL || "gemini-2.5-flash";

  const prompt = `
Tu es un ingénieur du son et directeur artistique musical.
Analyse ce morceau audio pour aider une application de mastering IA.
Tu dois te concentrer sur la voix, l'émotion, le mix ressenti et les décisions utiles avant mastering.
Réponds uniquement avec un JSON valide.
Aucun markdown.
Aucun texte avant ou après.

Format obligatoire :
{
  "model": "${modelName}",
  "vocal_presence": "voix absente|voix faible|voix équilibrée|voix trop forte|non déterminé",
  "vocal_clarity": "string",
  "vocal_energy": "string",
  "emotion": "string",
  "musical_style": "string",
  "perceived_mix": "string",
  "issues": ["string"],
  "recommendations": ["string"],
  "mastering_intent": "string",
  "confidence": 0.8
}

Demande utilisateur :
${cleanText(userPrompt, "Rendre le morceau plus propre, plus fort et plus professionnel.")}

Analyse technique Python disponible :
${JSON.stringify(technicalAnalysis || {}, null, 2)}
`.trim();

  try {
    const model = gemini.getGenerativeModel({ model: modelName });
    const result = await model.generateContent([
      { text: prompt },
      {
        inlineData: {
          mimeType,
          data: audioBuffer.toString("base64")
        }
      }
    ]);

    const text = result?.response?.text?.() || "";
    const parsed = extractJsonLoose(text);
    return normalizeGeminiAudioResult({ ...parsed, model: modelName });
  } catch (error) {
    console.warn("[GEMINI_AUDIO] Analyse ignorée :", error?.message || error);
    return buildGeminiAudioFallback(error?.message || "Erreur Gemini");
  }
}

export function mergeTechnicalAndGeminiAnalysis(technicalAnalysis = {}, geminiAnalysis = {}) {
  return {
    ...(technicalAnalysis || {}),
    gemini_audio: geminiAnalysis || buildGeminiAudioFallback()
  };
}
