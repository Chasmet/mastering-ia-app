export function initAdminStatsV2({
  BACKEND_URL,
  adminToken,
  elements,
  helpers
}) {
  const {
    adminStatsSection,
    adminStatsMonthRevenue,
    adminStatsQuarterRevenue,
    adminStatsUsers,
    adminStatsActiveUsers,
    adminStatsZeroUsers,
    adminStatsPendingPayments,
    adminStatsTopPack,
    adminStatsTopPackMeta,
    adminStatsPeriod,
    adminStatsMonthlyList,
    adminStatsRefreshBtn
  } = elements;

  const {
    money,
    setAdminActionFeedback,
    getSelectedQuarter,
    getSelectedYear
  } = helpers;

  function setText(el, value) {
    if (el) el.textContent = value;
  }

  function clearStatsUi(message = "Aucune donnée.") {
    setText(adminStatsMonthRevenue, "-");
    setText(adminStatsQuarterRevenue, "-");
    setText(adminStatsUsers, "-");
    setText(adminStatsActiveUsers, "-");
    setText(adminStatsZeroUsers, "-");
    setText(adminStatsPendingPayments, "-");
    setText(adminStatsTopPack, "-");
    setText(adminStatsTopPackMeta, "-");
    setText(adminStatsPeriod, "-");

    if (adminStatsMonthlyList) {
      adminStatsMonthlyList.innerHTML = `
        <div class="admin-item">
          <div class="admin-item-sub">${message}</div>
        </div>
      `;
    }
  }

  async function adminFetchStats(path) {
    const token = typeof adminToken === "function" ? adminToken() : "";
    if (!token) {
      throw new Error("Connexion admin requise");
    }

    const response = await fetch(`${BACKEND_URL}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    const rawText = await response.text();
    let data = null;

    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch {
      data = null;
    }

    if (!response.ok) {
      throw new Error(data?.error || rawText || `Erreur HTTP ${response.status}`);
    }

    return data;
  }

  function renderMonthlyBreakdown(items = []) {
    if (!adminStatsMonthlyList) return;

    if (!Array.isArray(items) || !items.length) {
      adminStatsMonthlyList.innerHTML = `
        <div class="admin-item">
          <div class="admin-item-sub">Aucune donnée mensuelle.</div>
        </div>
      `;
      return;
    }

    adminStatsMonthlyList.innerHTML = items.map((item) => `
      <div class="admin-item">
        <div class="admin-item-top">
          <span>${item.monthName || "-"}</span>
          <span>${money(item.revenueEur || 0)}</span>
        </div>
      </div>
    `).join("");
  }

  function applyStats(stats = {}) {
    if (adminStatsSection) {
      adminStatsSection.classList.remove("hidden");
    }

    setText(adminStatsMonthRevenue, money(stats?.currentMonth?.revenueEur || 0));
    setText(adminStatsQuarterRevenue, money(stats?.currentQuarter?.revenueEur || 0));
    setText(adminStatsUsers, String(stats?.users?.totalUsers ?? 0));
    setText(adminStatsActiveUsers, String(stats?.users?.activeUsersLast30Days ?? 0));
    setText(adminStatsZeroUsers, String(stats?.users?.zeroGenerationUsers ?? 0));
    setText(adminStatsPendingPayments, String(stats?.payments?.pendingCount ?? 0));
    setText(adminStatsTopPack, stats?.highlights?.topPackName || "-");
    setText(adminStatsPeriod, stats?.selectedPeriod?.label || "-");

    const salesCount = stats?.highlights?.topPackSalesCount ?? 0;
    const revenue = money(stats?.highlights?.topPackRevenueEur || 0);
    setText(adminStatsTopPackMeta, `${salesCount} vente(s) · ${revenue}`);

    renderMonthlyBreakdown(stats?.monthlyBreakdown || []);
  }

  async function loadAdminStats() {
    try {
      const quarter = typeof getSelectedQuarter === "function" ? getSelectedQuarter() : 1;
      const year = typeof getSelectedYear === "function" ? getSelectedYear() : new Date().getFullYear();

      const data = await adminFetchStats(
        `/api/admin/business-stats?quarter=${encodeURIComponent(quarter)}&year=${encodeURIComponent(year)}`
      );

      applyStats(data?.stats || {});
    } catch (error) {
      clearStatsUi("Impossible de charger les statistiques.");
      if (typeof setAdminActionFeedback === "function") {
        setAdminActionFeedback(`Erreur stats : ${error.message || "impossible"}`, true);
      }
    }
  }

  if (adminStatsRefreshBtn) {
    adminStatsRefreshBtn.addEventListener("click", loadAdminStats);
  }

  return {
    loadAdminStats,
    clearStatsUi
  };
}
