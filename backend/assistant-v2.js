import { createTrackedOpenAIResponse } from "./openai-usage-v2.js";

function cleanText(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function cleanEmail(value) {
  return cleanText(value).toLowerCase();
}

function containsAny(text, words = []) {
  return words.some((word) => text.includes(word));
}

function extractJsonLoose(text) {
  if (!text || typeof text !== "string") {
    throw new Error("Réponse IA vide");
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

  throw new Error("JSON IA introuvable");
}

function buildDefaultReply() {
  return {
    shortSummary: "Demande analysée.",
    requestType: "support_general",
    priority: "normale",
    riskLevel: "faible",
    adminAction: "Lire la demande puis répondre au client.",
    statusSuggestion: "a_traiter",
    suggestedReply:
      "Bonjour, votre demande a bien été prise en compte. Nous vérifions la situation et revenons vers vous rapidement.",
    internalNote: "Cas standard.",
    confidence: 0.6
  };
}

function classifyByRules(payload) {
  const fallback = buildDefaultReply();

  const clientMessage = cleanText(payload?.clientMessage, "");
  const packName = cleanText(payload?.packName, "");
  const paymentStatus = cleanText(payload?.paymentStatus, "");
  const appArea = cleanText(payload?.appArea, "");
  const email = cleanEmail(payload?.clientEmail || "");

  const text = `${clientMessage} ${packName} ${paymentStatus} ${appArea}`.toLowerCase();

  const hasUrgency = containsAny(text, [
    "urgent",
    "vite",
    "rapidement",
    "bloqué",
    "bloquee",
    "impossible",
    "ça marche pas",
    "ca marche pas",
    "bug",
    "erreur"
  ]);

  const asksRefund = containsAny(text, [
    "rembourse",
    "rembourser",
    "remboursement",
    "rembourser moi",
    "arnaque"
  ]);

  const paymentSignal = containsAny(text, [
    "j'ai payé",
    "jai payé",
    "payé",
    "paye",
    "paiement",
    "revolut",
    "preuve",
    "capture",
    "ticket"
  ]);

  const generationsSignal = containsAny(text, [
    "generation",
    "génération",
    "credit",
    "crédit",
    "solde",
    "plus de generation",
    "plus de génération",
    "0 generation",
    "0 génération"
  ]);

  const bugSignal = containsAny(text, [
    "bug",
    "erreur",
    "impossible",
    "bloqué",
    "bloquee",
    "ne marche pas",
    "marche pas",
    "connexion",
    "telechargement",
    "téléchargement",
    "traitement impossible",
    "analyser impossible"
  ]);

  const fraudSignal = containsAny(text, [
    "arnaque",
    "faux",
    "mensonge",
    "preuve manquante",
    "pas recu",
    "pas reçu",
    "déjà payé",
    "deja payé",
    "deja paye",
    "déjà paye"
  ]);

  const comptaSignal = containsAny(text, [
    "urssaf",
    "declaration",
    "déclaration",
    "compta",
    "trimestre",
    "vente",
    "depense",
    "dépense"
  ]);

  let requestType = "support_general";
  let priority = "normale";
  let riskLevel = "faible";
  let adminAction = fallback.adminAction;
  let statusSuggestion = "a_traiter";
  let shortSummary = "Demande support générale.";
  let suggestedReply = fallback.suggestedReply;
  let internalNote = "Lecture humaine recommandée.";

  if (comptaSignal || appArea === "compta") {
    requestType = "comptabilite";
    priority = "faible";
    riskLevel = "faible";
    adminAction = "Vérifier les données comptables puis confirmer la réponse attendue.";
    statusSuggestion = "a_traiter";
    shortSummary = "Question liée à la comptabilité ou au rapport trimestriel.";
    suggestedReply =
      "Bonjour, votre demande liée à la comptabilité a bien été prise en compte. Nous vérifions les données concernées et revenons vers vous rapidement.";
    internalNote = "Cas comptable interne.";
  }

  if (generationsSignal || appArea === "generations") {
    requestType = "generations";
    priority = hasUrgency ? "haute" : "normale";
    riskLevel = "faible";
    adminAction = "Vérifier le solde du client, l'historique des générations et les derniers traitements.";
    statusSuggestion = "a_traiter";
    shortSummary = "Question ou problème lié au solde de générations.";
    suggestedReply =
      "Bonjour, nous vérifions actuellement votre solde de générations et l'historique de votre compte. Nous revenons vers vous rapidement avec une réponse précise.";
    internalNote = email ? `Contrôler le compte ${email}.` : "Contrôler le compte client.";
  }

  if (paymentSignal || appArea === "paiement") {
    requestType = "paiement";
    priority = hasUrgency ? "haute" : "normale";
    riskLevel = fraudSignal ? "eleve" : "moyen";
    adminAction = fraudSignal
      ? "Vérifier la demande de paiement, comparer avec l'historique et demander une preuve si nécessaire."
      : "Vérifier la demande en attente, le pack concerné et valider si le paiement est confirmé.";
    statusSuggestion = fraudSignal ? "en_attente_client" : "a_traiter";
    shortSummary = fraudSignal
      ? "Paiement signalé avec doute ou incohérence possible."
      : "Client signale un paiement ou demande une recharge.";
    suggestedReply = fraudSignal
      ? "Bonjour, nous avons bien reçu votre message. Pour finaliser la vérification, merci d'envoyer une preuve de paiement claire avec l'email utilisé dans l'application."
      : "Bonjour, votre message concernant le paiement a bien été reçu. Nous vérifions la demande et ajoutons les générations dès validation.";
    internalNote = fraudSignal
      ? "Doute paiement : contrôler doublons, historique et cohérence email."
      : "Paiement à contrôler côté admin.";
  }

  if (bugSignal || appArea === "support_client") {
    requestType = bugSignal ? "bug_technique" : requestType;
    priority = hasUrgency ? "haute" : priority;
    riskLevel = bugSignal ? "moyen" : riskLevel;
    adminAction = bugSignal
      ? "Identifier si le blocage concerne connexion, paiement, analyse ou traitement puis répondre avec une action claire."
      : adminAction;
    statusSuggestion = bugSignal ? "a_traiter" : statusSuggestion;
    shortSummary = bugSignal ? "Blocage ou bug signalé par le client." : shortSummary;
    suggestedReply = bugSignal
      ? "Bonjour, nous avons bien reçu votre signalement. Nous vérifions le blocage rencontré et revenons vers vous rapidement avec une solution."
      : suggestedReply;
    internalNote = bugSignal
      ? "Vérifier logs, route touchée et état du compte client."
      : internalNote;
  }

  if (asksRefund) {
    requestType = "remboursement";
    priority = "haute";
    riskLevel = "eleve";
    adminAction = "Ne pas rembourser automatiquement. Vérifier le contexte complet, l'historique et décider manuellement.";
    statusSuggestion = "en_attente_client";
    shortSummary = "Demande de remboursement ou contestation client.";
    suggestedReply =
      "Bonjour, votre demande a bien été reçue. Nous vérifions actuellement l'historique de votre compte et revenons vers vous rapidement.";
    internalNote = "Cas sensible : décision manuelle recommandée.";
  }

  if (fraudSignal && requestType !== "remboursement") {
    requestType = "risque_paiement";
    priority = "haute";
    riskLevel = "eleve";
    adminAction = "Contrôler l'historique complet avant toute validation. Demander une preuve si besoin.";
    statusSuggestion = "en_attente_client";
    shortSummary = "Demande à risque ou incohérente autour d'un paiement.";
    suggestedReply =
      "Bonjour, nous avons bien reçu votre message. Afin de vérifier correctement la situation, merci de nous transmettre une preuve de paiement claire avec l'email utilisé dans l'application.";
    internalNote = "Risque élevé, éviter toute validation automatique.";
  }

  return {
    shortSummary,
    requestType,
    priority,
    riskLevel,
    adminAction,
    statusSuggestion,
    suggestedReply,
    internalNote,
    confidence: 0.7
  };
}

function normalizeAssistantResult(raw, fallback) {
  const result = raw && typeof raw === "object" ? raw : {};
  return {
    shortSummary: cleanText(result.shortSummary, fallback.shortSummary),
    requestType: cleanText(result.requestType, fallback.requestType),
    priority: cleanText(result.priority, fallback.priority),
    riskLevel: cleanText(result.riskLevel, fallback.riskLevel),
    adminAction: cleanText(result.adminAction, fallback.adminAction),
    statusSuggestion: cleanText(result.statusSuggestion, fallback.statusSuggestion),
    suggestedReply: cleanText(result.suggestedReply, fallback.suggestedReply),
    internalNote: cleanText(result.internalNote, fallback.internalNote),
    confidence: Number.isFinite(Number(result.confidence))
      ? Math.max(0, Math.min(1, Number(result.confidence)))
      : fallback.confidence
  };
}

export async function buildInternalAssistantReplyV2({
  openai,
  supabase,
  payload,
  normalizeText,
  normalizeEmail
}) {
  const safePayload = {
    clientEmail: typeof normalizeEmail === "function"
      ? normalizeEmail(payload?.clientEmail || "")
      : cleanEmail(payload?.clientEmail || ""),
    clientMessage: typeof normalizeText === "function"
      ? normalizeText(payload?.clientMessage, "")
      : cleanText(payload?.clientMessage, ""),
    packName: typeof normalizeText === "function"
      ? normalizeText(payload?.packName, "")
      : cleanText(payload?.packName, ""),
    paymentStatus: typeof normalizeText === "function"
      ? normalizeText(payload?.paymentStatus, "")
      : cleanText(payload?.paymentStatus, ""),
    appArea: typeof normalizeText === "function"
      ? normalizeText(payload?.appArea, "")
      : cleanText(payload?.appArea, "")
  };

  const fallback = classifyByRules(safePayload);

  if (!safePayload.clientMessage) {
    return fallback;
  }

  const systemPrompt = `
Tu es l'assistant interne privé de Mastering IA.
Tu aides uniquement l'administrateur.
Tu ne réponds jamais comme si tu étais visible publiquement.
Tu réponds uniquement avec un JSON valide.
Aucun markdown.
Aucun texte avant.
Aucun texte après.

Format obligatoire :
{
  "shortSummary": "string",
  "requestType": "paiement|generations|bug_technique|remboursement|comptabilite|risque_paiement|support_general",
  "priority": "faible|normale|haute",
  "riskLevel": "faible|moyen|eleve",
  "adminAction": "string",
  "statusSuggestion": "a_traiter|en_attente_client|traite",
  "suggestedReply": "string",
  "internalNote": "string",
  "confidence": 0.85
}

Contexte métier à respecter :
- analyse = gratuite
- traiter = 1 génération
- paiement Revolut = validation manuelle par l'admin
- après paiement, la recharge est ajoutée manuellement
- le client doit utiliser le même email que dans l'application
- ne jamais promettre une validation déjà faite si elle n'est pas confirmée
- si doute : demander une preuve claire
- si remboursement : ne jamais valider automatiquement
- rester concret, utile et court
`.trim();

  const input = [
    { role: "system", content: systemPrompt },
    { role: "user", content: JSON.stringify(safePayload, null, 2) }
  ];

  try {
    const { outputText } = await createTrackedOpenAIResponse({
      openai,
      supabase,
      feature: "assistant_admin_v2",
      model: process.env.OPENAI_ASSISTANT_MODEL || "gpt-5-mini",
      input,
      metadata: {
        appArea: safePayload.appArea || "",
        requestType: fallback.requestType,
        hasClientEmail: Boolean(safePayload.clientEmail)
      }
    });

    const parsed = extractJsonLoose(outputText || "");
    return normalizeAssistantResult(parsed, fallback);
  } catch {
    return fallback;
  }
}
