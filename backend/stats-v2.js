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

function roundMoney(value) {
  return Number(safeNum(null, value, 0).toFixed(2));
}

function uniqueCount(values = []) {
  return new Set(
    values
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  ).size;
}

function getNowParts() {
  const now = new Date();
  return {
    year: now.getFullYear(),
    monthNumber: now.getMonth() + 1,
    quarter: Math.floor(now.getMonth() / 3) + 1
  };
}

function buildQuarterMonthsLocal(quarter, year) {
  const safeQuarter = localClamp(Number(quarter) || 1, 1, 4);
  const startMonth = (safeQuarter - 1) * 3 + 1;

  return [0, 1, 2].map((offset) => {
    const monthNumber = startMonth + offset;
    return {
      monthNumber,
      monthName: MONTHS_FR[monthNumber - 1],
      monthLabel: `${MONTHS_FR[monthNumber - 1]} ${year}`
    };
  });
}

function getQuarterMonthsSafe(getQuarterMonths, quarter, year) {
  if (typeof getQuarterMonths === "function") {
    return getQuarterMonths(quarter, year);
  }
  return buildQuarterMonthsLocal(quarter, year);
}

export async function buildBusinessStatsV2({
  supabase,
  quarterInput,
  yearInput,
  safeNumber,
  clamp,
  getCurrentQuarterYear,
  getQuarterMonths
}) {
  const now = getNowParts();
  const current = typeof getCurrentQuarterYear === "function"
    ? getCurrentQuarterYear()
    : { quarter: now.quarter, year: now.year };

  const clampFn = typeof clamp === "function" ? clamp : localClamp;

  const quarter = clampFn(safeNum(safeNumber, quarterInput, current.quarter), 1, 4);
  const year = clampFn(safeNum(safeNumber, yearInput, current.year), 2020, 2100);

  const quarterMonths = getQuarterMonthsSafe(getQuarterMonths, quarter, year);
  const quarterMonthSet = new Set(quarterMonths.map((item) => item.monthNumber));

  const { data: salesQuarterRaw, error: salesQuarterError } = await supabase
    .from("admin_sales")
    .select("*")
    .eq("quarter", quarter)
    .eq("year", year)
    .order("sale_date", { ascending: false });

  if (salesQuarterError) {
    throw new Error(`Erreur stats ventes trimestre : ${salesQuarterError.message}`);
  }

  const { data: salesMonthRaw, error: salesMonthError } = await supabase
    .from("admin_sales")
    .select("amount_eur")
    .eq("year", now.year)
    .eq("month_number", now.monthNumber);

  if (salesMonthError) {
    throw new Error(`Erreur stats ventes mois : ${salesMonthError.message}`);
  }

  const { data: usersRaw, error: usersError } = await supabase
    .from("app_users")
    .select("id,email,current_generations,created_at");

  if (usersError) {
    throw new Error(`Erreur stats utilisateurs : ${usersError.message}`);
  }

  const { data: paymentsRaw, error: paymentsError } = await supabase
    .from("payment_requests")
    .select("id,status,created_at");

  if (paymentsError) {
    throw new Error(`Erreur stats paiements : ${paymentsError.message}`);
  }

  const activeSinceIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: generationEventsRaw, error: generationEventsError } = await supabase
    .from("app_generation_events")
    .select("user_id,created_at")
    .gte("created_at", activeSinceIso);

  if (generationEventsError) {
    throw new Error(`Erreur stats activité : ${generationEventsError.message}`);
  }

  const salesQuarter = Array.isArray(salesQuarterRaw) ? salesQuarterRaw : [];
  const salesMonth = Array.isArray(salesMonthRaw) ? salesMonthRaw : [];
  const users = Array.isArray(usersRaw) ? usersRaw : [];
  const payments = Array.isArray(paymentsRaw) ? paymentsRaw : [];
  const generationEvents = Array.isArray(generationEventsRaw) ? generationEventsRaw : [];

  const currentMonthRevenueEur = roundMoney(
    salesMonth.reduce((sum, row) => sum + safeNum(safeNumber, row.amount_eur, 0), 0)
  );

  const currentQuarterRevenueEur = roundMoney(
    salesQuarter.reduce((sum, row) => sum + safeNum(safeNumber, row.amount_eur, 0), 0)
  );

  const monthlyRevenueMap = new Map(quarterMonths.map((item) => [item.monthNumber, 0]));
  for (const row of salesQuarter) {
    const monthNumber = safeNum(safeNumber, row.month_number, 0);
    if (!quarterMonthSet.has(monthNumber)) continue;
    const currentValue = monthlyRevenueMap.get(monthNumber) || 0;
    monthlyRevenueMap.set(
      monthNumber,
      currentValue + safeNum(safeNumber, row.amount_eur, 0)
    );
  }

  const monthlyBreakdown = quarterMonths.map((item) => ({
    monthNumber: item.monthNumber,
    monthName: item.monthName,
    monthLabel: item.monthLabel,
    revenueEur: roundMoney(monthlyRevenueMap.get(item.monthNumber) || 0)
  }));

  const packMap = new Map();
  for (const row of salesQuarter) {
    const packName = String(row.pack_name || "Pack non précisé").trim();
    const existing = packMap.get(packName) || {
      packName,
      salesCount: 0,
      revenueEur: 0,
      generationsSold: 0
    };

    existing.salesCount += 1;
    existing.revenueEur += safeNum(safeNumber, row.amount_eur, 0);
    existing.generationsSold += Math.max(0, safeNum(safeNumber, row.generations_added, 0));

    packMap.set(packName, existing);
  }

  const packs = [...packMap.values()]
    .map((item) => ({
      ...item,
      revenueEur: roundMoney(item.revenueEur)
    }))
    .sort((a, b) => {
      if (b.revenueEur !== a.revenueEur) return b.revenueEur - a.revenueEur;
      return b.salesCount - a.salesCount;
    });

  const totalUsers = users.length;
  const usersWithGenerations = users.filter(
    (user) => safeNum(safeNumber, user.current_generations, 0) > 0
  ).length;
  const zeroGenerationUsers = users.filter(
    (user) => safeNum(safeNumber, user.current_generations, 0) <= 0
  ).length;
  const activeUsersLast30Days = uniqueCount(generationEvents.map((row) => row.user_id));
  const payingCustomersQuarter = uniqueCount(salesQuarter.map((row) => row.customer_name));

  const pendingCount = payments.filter((row) => row.status === "en_attente").length;
  const processedCount = payments.filter((row) => row.status === "traite").length;
  const canceledCount = payments.filter((row) => row.status === "annule").length;

  const totalSalesCount = salesQuarter.length;
  const averageTicketEur = totalSalesCount > 0
    ? roundMoney(currentQuarterRevenueEur / totalSalesCount)
    : 0;

  return {
    selectedPeriod: {
      quarter,
      year,
      label: `${quarterMonths.map((item) => item.monthName).join(", ")} ${year}`
    },
    currentMonth: {
      monthNumber: now.monthNumber,
      monthName: MONTHS_FR[now.monthNumber - 1],
      year: now.year,
      revenueEur: currentMonthRevenueEur
    },
    currentQuarter: {
      quarter,
      year,
      revenueEur: currentQuarterRevenueEur,
      salesCount: totalSalesCount,
      averageTicketEur,
      payingCustomersQuarter
    },
    users: {
      totalUsers,
      usersWithGenerations,
      zeroGenerationUsers,
      activeUsersLast30Days
    },
    payments: {
      totalCount: payments.length,
      pendingCount,
      processedCount,
      canceledCount
    },
    highlights: {
      topPackName: packs[0]?.packName || "-",
      topPackRevenueEur: packs[0]?.revenueEur || 0,
      topPackSalesCount: packs[0]?.salesCount || 0
    },
    packs,
    monthlyBreakdown
  };
}
