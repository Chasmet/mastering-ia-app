function localHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function makeHttpError(buildHttpError, status, message) {
  if (typeof buildHttpError === "function") {
    return buildHttpError(status, message);
  }
  return localHttpError(status, message);
}

function toTimestamp(value) {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function safeNormalizeText(normalizeText, value, fallback = "") {
  if (typeof normalizeText === "function") {
    return normalizeText(value, fallback);
  }
  return typeof value === "string" ? value.trim() : fallback;
}

function safeNormalizeEmail(normalizeEmail, value) {
  if (typeof normalizeEmail === "function") {
    return normalizeEmail(value);
  }
  return String(value || "").trim().toLowerCase();
}

function safeNumberValue(safeNumber, value, fallback = 0) {
  if (typeof safeNumber === "function") {
    return safeNumber(value, fallback);
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

export async function getPaymentRequestByIdV2({ supabase, id }) {
  const { data, error } = await supabase
    .from("payment_requests")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data || null;
}

export async function listClientPaymentRequestsV2({ supabase, email }) {
  const { data, error } = await supabase
    .from("payment_requests")
    .select("*")
    .eq("client_email", String(email || "").trim().toLowerCase())
    .order("created_at", { ascending: false })
    .limit(30);

  if (error) {
    throw new Error(error.message);
  }

  return Array.isArray(data) ? data : [];
}

export async function listAdminPaymentRequestsV2({ supabase }) {
  const { data, error } = await supabase
    .from("payment_requests")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    throw new Error(error.message);
  }

  const rows = Array.isArray(data) ? data : [];

  return {
    pending: rows.filter((row) => row.status === "en_attente"),
    recent: rows.filter((row) => row.status !== "en_attente").slice(0, 30)
  };
}

export async function createPaymentRequestV2({
  supabase,
  clientUser,
  packKey,
  clientNote,
  getPackConfig,
  buildHttpError,
  normalizeText
}) {
  const pack = typeof getPackConfig === "function" ? getPackConfig(packKey) : null;

  if (!pack) {
    throw makeHttpError(buildHttpError, 400, "Pack invalide");
  }

  const clientEmail = String(clientUser?.email || "").trim().toLowerCase();

  if (!clientEmail) {
    throw makeHttpError(buildHttpError, 400, "Compte client invalide");
  }

  const { data: existingRows, error: existingError } = await supabase
    .from("payment_requests")
    .select("*")
    .eq("client_email", clientEmail)
    .order("created_at", { ascending: false })
    .limit(20);

  if (existingError) {
    throw new Error(existingError.message);
  }

  const rows = Array.isArray(existingRows) ? existingRows : [];
  const pendingRows = rows.filter((row) => row.status === "en_attente");

  const duplicateSamePack = pendingRows.find((row) => row.pack_key === pack.key);
  if (duplicateSamePack) {
    throw makeHttpError(
      buildHttpError,
      409,
      "Une demande en attente existe déjà pour ce pack"
    );
  }

  if (pendingRows.length >= 3) {
    throw makeHttpError(
      buildHttpError,
      429,
      "Trop de demandes en attente sur ce compte"
    );
  }

  const latestRequest = rows[0] || null;
  if (latestRequest) {
    const secondsSinceLatest = (Date.now() - toTimestamp(latestRequest.created_at)) / 1000;
    if (secondsSinceLatest >= 0 && secondsSinceLatest < 90) {
      throw makeHttpError(
        buildHttpError,
        429,
        "Attends un peu avant d'envoyer une nouvelle demande"
      );
    }
  }

  const payload = {
    client_user_id: clientUser.id,
    client_email: clientEmail,
    pack_key: pack.key,
    pack_name: pack.pack_name,
    amount_eur: pack.amount_eur,
    generations_to_add: pack.generations_to_add,
    revolut_link: pack.revolut_link,
    client_note: safeNormalizeText(normalizeText, clientNote, ""),
    status: "en_attente"
  };

  const { data, error } = await supabase
    .from("payment_requests")
    .insert([payload])
    .select()
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

export async function approvePaymentRequestV2({
  supabase,
  paymentRequestId,
  adminEmail,
  adminNote,
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
}) {
  const paymentRequest = await getPaymentRequestByIdV2({
    supabase,
    id: paymentRequestId
  });

  if (!paymentRequest) {
    throw makeHttpError(buildHttpError, 404, "Demande de paiement introuvable");
  }

  if (paymentRequest.status !== "en_attente") {
    throw makeHttpError(buildHttpError, 409, "Cette demande a déjà été traitée");
  }

  const targetEmail = safeNormalizeEmail(normalizeEmail, paymentRequest.client_email);

  const user = paymentRequest.client_user_id
    ? await getUserById(paymentRequest.client_user_id)
    : await getUserByEmail(targetEmail);

  if (!user) {
    throw makeHttpError(buildHttpError, 404, "Client introuvable pour cette demande");
  }

  const generationsToAdd = Math.max(
    0,
    safeNumberValue(safeNumber, paymentRequest.generations_to_add, 0)
  );

  const currentBalance = Math.max(
    0,
    safeNumberValue(safeNumber, user.current_generations, 0)
  );

  const nextBalance = currentBalance + generationsToAdd;

  const updatedUser = await updateUserGenerations(user.id, nextBalance);

  await insertGenerationEvent({
    userId: user.id,
    delta: generationsToAdd,
    reason: "payment_request_approved",
    note: `Recharge manuelle validée - ${paymentRequest.pack_name}`
  });

  const saleDate = typeof normalizeDateInput === "function"
    ? normalizeDateInput(new Date())
    : new Date().toISOString().slice(0, 10);

  const period = typeof buildPeriodInfo === "function"
    ? buildPeriodInfo(saleDate)
    : {
        normalizedDate: saleDate,
        year: new Date(saleDate).getFullYear(),
        quarter: Math.floor(new Date(saleDate).getMonth() / 3) + 1,
        quarterLabel: "",
        monthNumber: new Date(saleDate).getMonth() + 1,
        monthLabel: ""
      };

  const salePayload = {
    sale_date: period.normalizedDate,
    year: period.year,
    quarter: period.quarter,
    quarter_label: period.quarterLabel,
    month_number: period.monthNumber,
    month_label: period.monthLabel,
    customer_name: updatedUser.email,
    pack_name: paymentRequest.pack_name,
    amount_eur: Number(safeNumberValue(safeNumber, paymentRequest.amount_eur, 0).toFixed(2)),
    generations_added: generationsToAdd,
    payment_method: "Revolut",
    note:
      safeNormalizeText(normalizeText, adminNote, "") ||
      `Validation manuelle demande ${paymentRequest.id}`
  };

  const { data: saleRow, error: saleError } = await supabase
    .from("admin_sales")
    .insert([salePayload])
    .select()
    .single();

  if (saleError) {
    throw new Error(saleError.message);
  }

  const { data: updatedPayment, error: paymentError } = await supabase
    .from("payment_requests")
    .update({
      status: "traite",
      treated_at: nowIso(),
      treated_by: safeNormalizeEmail(normalizeEmail, adminEmail),
      admin_note: safeNormalizeText(normalizeText, adminNote, ""),
      client_user_id: updatedUser.id
    })
    .eq("id", paymentRequest.id)
    .select()
    .single();

  if (paymentError) {
    throw new Error(paymentError.message);
  }

  return {
    paymentRequest: updatedPayment,
    user: updatedUser,
    sale: saleRow
  };
}

export async function cancelPaymentRequestV2({
  supabase,
  paymentRequestId,
  adminEmail,
  adminNote,
  buildHttpError,
  normalizeText,
  normalizeEmail
}) {
  const paymentRequest = await getPaymentRequestByIdV2({
    supabase,
    id: paymentRequestId
  });

  if (!paymentRequest) {
    throw makeHttpError(buildHttpError, 404, "Demande de paiement introuvable");
  }

  if (paymentRequest.status !== "en_attente") {
    throw makeHttpError(buildHttpError, 409, "Cette demande a déjà été traitée");
  }

  const { data, error } = await supabase
    .from("payment_requests")
    .update({
      status: "annule",
      treated_at: nowIso(),
      treated_by: safeNormalizeEmail(normalizeEmail, adminEmail),
      admin_note: safeNormalizeText(normalizeText, adminNote, "")
    })
    .eq("id", paymentRequest.id)
    .select()
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}
