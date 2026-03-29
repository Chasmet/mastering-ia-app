const MONTHS_FR = [
  "janvier", "février", "mars",
  "avril", "mai", "juin",
  "juillet", "août", "septembre",
  "octobre", "novembre", "décembre"
];

function safeNum(safeNumber, value, fallback = 0) {
  if (typeof safeNumber === "function") {
    return safeNumber(value, fallback);
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function localClamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeTextLocal(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function formatEuroLocal(value) {
  const num = Number(safeNum(null, value, 0).toFixed(2));
  if (Number.isInteger(num)) {
    return `${num} €`;
  }
  return `${num.toFixed(2).replace(".", ",")} €`;
}

function getCurrentQuarterYearLocal() {
  const now = new Date();
  return {
    quarter: Math.floor(now.getMonth() / 3) + 1,
    year: now.getFullYear()
  };
}

function getQuarterMonthsLocal(quarter, year) {
  const safeQuarter = localClamp(Number(quarter) || 1, 1, 4);
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

function buildFallbackQuarterReport(context, formatEuroText) {
  const formatMoney = typeof formatEuroText === "function" ? formatEuroText : formatEuroLocal;

  const monthlyLines = context.summary.monthlySales
    .map((item) => `- ${item.monthName} : ${formatMoney(item.totalEur)}`)
    .join("\n");

  const expenseLines = context.summary.expenseGroups.length
    ? context.summary.expenseGroups
        .map((item) => `- ${item.category} : ${formatMoney(item.totalEur)}`)
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
    formatMoney(context.summary.declarationTotalEur),
    "",
    "Dépenses internes :",
    expenseLines,
    "",
    "Total dépenses internes :",
    formatMoney(context.summary.expensesTotalEur),
    "",
    "Marge interne indicative :",
    formatMoney(context.summary.internalNetEur)
  ].join("\n");
}

export async function createSaleV2({
  supabase,
  payload,
  normalizeDateInput,
  buildPeriodInfo,
  normalizeText,
  safeNumber
}) {
  const saleDate = typeof normalizeDateInput === "function"
    ? normalizeDateInput(payload?.saleDate)
    : new Date().toISOString().slice(0, 10);

  const customerName = typeof normalizeText === "function"
    ? normalizeText(payload?.customerName, "Client non précisé")
    : normalizeTextLocal(payload?.customerName, "Client non précisé");

  const packName = typeof normalizeText === "function"
    ? normalizeText(payload?.packName, "Pack non précisé")
    : normalizeTextLocal(payload?.packName, "Pack non précisé");

  const amountEur = safeNum(safeNumber, payload?.amountEur, NaN);
  const generationsAdded = Math.max(0, Math.round(safeNum(safeNumber, payload?.generationsAdded, 0)));

  const paymentMethod = typeof normalizeText === "function"
    ? normalizeText(payload?.paymentMethod, "Paiement non précisé")
    : normalizeTextLocal(payload?.paymentMethod, "Paiement non précisé");

  const note = typeof normalizeText === "function"
    ? normalizeText(payload?.note, "")
    : normalizeTextLocal(payload?.note, "");

  if (!Number.isFinite(amountEur) || amountEur <= 0) {
    const error = new Error("Montant de vente invalide");
    error.status = 400;
    throw error;
  }

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

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

export async function createExpenseV2({
  supabase,
  payload,
  normalizeDateInput,
  buildPeriodInfo,
  normalizeText,
  safeNumber
}) {
  const expenseDate = typeof normalizeDateInput === "function"
    ? normalizeDateInput(payload?.expenseDate)
    : new Date().toISOString().slice(0, 10);

  const category = typeof normalizeText === "function"
    ? normalizeText(payload?.category, "Dépense")
    : normalizeTextLocal(payload?.category, "Dépense");

  const amountEur = safeNum(safeNumber, payload?.amountEur, NaN);

  const vendorName = typeof normalizeText === "function"
    ? normalizeText(payload?.vendorName, "Fournisseur non précisé")
    : normalizeTextLocal(payload?.vendorName, "Fournisseur non précisé");

  const note = typeof normalizeText === "function"
    ? normalizeText(payload?.note, "")
    : normalizeTextLocal(payload?.note, "");

  if (!Number.isFinite(amountEur) || amountEur <= 0) {
    const error = new Error("Montant de dépense invalide");
    error.status = 400;
    throw error;
  }

  const period = typeof buildPeriodInfo === "function"
    ? buildPeriodInfo(expenseDate)
    : {
        normalizedDate: expenseDate,
        year: new Date(expenseDate).getFullYear(),
        quarter: Math.floor(new Date(expenseDate).getMonth() / 3) + 1,
        quarterLabel: "",
        monthNumber: new Date(expenseDate).getMonth() + 1,
        monthLabel: ""
      };

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

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

export async function buildQuarterDataV2({
  supabase,
  quarterInput,
  yearInput,
  getCurrentQuarterYear,
  clamp,
  safeNumber,
  getQuarterMonths
}) {
  const current = typeof getCurrentQuarterYear === "function"
    ? getCurrentQuarterYear()
    : getCurrentQuarterYearLocal();

  const clampFn = typeof clamp === "function" ? clamp : localClamp;
  const quarter = clampFn(safeNum(safeNumber, quarterInput, current.quarter), 1, 4);
  const year = clampFn(safeNum(safeNumber, yearInput, current.year), 2020, 2100);

  const { data: salesRaw, error: salesError } = await supabase
    .from("admin_sales")
    .select("*")
    .eq("quarter", quarter)
    .eq("year", year)
    .order("sale_date", { ascending: false });

  if (salesError) {
    throw new Error(`Erreur ventes : ${salesError.message}`);
  }

  const { data: expensesRaw, error: expensesError } = await supabase
    .from("admin_expenses")
    .select("*")
    .eq("quarter", quarter)
    .eq("year", year)
    .order("expense_date", { ascending: false });

  if (expensesError) {
    throw new Error(`Erreur dépenses : ${expensesError.message}`);
  }

  const sales = Array.isArray(salesRaw) ? salesRaw : [];
  const expenses = Array.isArray(expensesRaw) ? expensesRaw : [];

  const quarterMonths = typeof getQuarterMonths === "function"
    ? getQuarterMonths(quarter, year)
    : getQuarterMonthsLocal(quarter, year);

  const monthlyTotals = new Map(quarterMonths.map((item) => [item.monthNumber, 0]));

  for (const row of sales) {
    const monthNumber = safeNum(safeNumber, row.month_number, 0);
    const currentValue = monthlyTotals.get(monthNumber) || 0;
    monthlyTotals.set(
      monthNumber,
      currentValue + safeNum(safeNumber, row.amount_eur, 0)
    );
  }

  const monthlySales = quarterMonths.map((item) => ({
    monthNumber: item.monthNumber,
    monthName: item.monthName,
    monthLabel: item.monthLabel,
    totalEur: Number((monthlyTotals.get(item.monthNumber) || 0).toFixed(2))
  }));

  const salesTotalEur = Number(
    sales.reduce((sum, row) => sum + safeNum(safeNumber, row.amount_eur, 0), 0).toFixed(2)
  );

  const expensesTotalEur = Number(
    expenses.reduce((sum, row) => sum + safeNum(safeNumber, row.amount_eur, 0), 0).toFixed(2)
  );

  const expenseGroupsMap = new Map();
  for (const row of expenses) {
    const key = String(row.category || "Dépense").trim() || "Dépense";
    expenseGroupsMap.set(
      key,
      (expenseGroupsMap.get(key) || 0) + safeNum(safeNumber, row.amount_eur, 0)
    );
  }

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
    sales,
    expenses
  };
}

export async function buildQuarterReportWithAIV2({
  openai,
  context,
  formatEuroText
}) {
  const fallbackReport = buildFallbackQuarterReport(context, formatEuroText);

  if (!openai) {
    return fallbackReport;
  }

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
