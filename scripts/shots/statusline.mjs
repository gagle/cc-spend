// Statusline shots: Pro/Max (two moments of one session) and Team/Enterprise. Made-up data, fixed clock.

const NOW = new Date("2026-11-16T15:20:00.000Z");
const H = 3_600_000;
const sec = (ms) => Math.floor((NOW.getTime() + ms) / 1000);

const cache = (fields = {}) => ({
  warm: true,
  secondsUntilCold: 245,
  ttlSeconds: 300,
  nextWarmUsd: 0.04,
  nextColdUsd: 1.24,
  missPremiumUsd: 1.2,
  sessionMissUsd: 0,
  expiresAt: sec(245_000),
  requests: 38,
  misses: 0,
  recentMiss: null,
  ...fields,
});

const base = {
  extraUsage: null,
  rateLimitsCache: null,
  spendLimitPct: null,
  cache: cache(),
  coach: null,
};

const payload = (fields = {}) => ({
  model: { display_name: "Opus 5.5" },
  effort: { level: "high" },
  workspace: { project_dir: "/work/shop-api" },
  cost: {
    total_cost_usd: 3.42,
    total_duration_ms: 48 * 60_000,
    total_api_duration_ms: 19 * 60_000,
  },
  context_window: {
    used_percentage: 14,
    context_window_size: 1_000_000,
    total_input_tokens: 140_000,
  },
  ...fields,
});

const limits = (fiveHourPct, sevenDayPct, fiveHourIn, sevenDayIn) => ({
  fiveHourPct,
  sevenDayPct,
  fiveHourResetsAt: sec(fiveHourIn),
  sevenDayResetsAt: sec(sevenDayIn),
  source: "hook",
});

export async function pro(dist) {
  const { renderStatusline } = await import(`${dist}/statusline-render.js`);
  const start = renderStatusline(
    payload(),
    {
      ...base,
      hasSpendCap: false,
      planType: "claude_pro",
      promptUsd: 0.31,
      rateLimits: limits(34, 21, 2.6 * H, 4.2 * 24 * H),
      runway: {
        fiveHour: {
          usedPct: 34,
          resetsAt: sec(2.6 * H),
          ratePctPerHour: 9,
          exhaustsAt: null,
          verdict: "comfortable",
        },
        sevenDay: {
          usedPct: 21,
          resetsAt: sec(4.2 * 24 * H),
          ratePctPerHour: 0.4,
          exhaustsAt: null,
          verdict: "on-track",
        },
      },
      coach: {
        id: "R13",
        title: "Cache expires in breaks",
        action: "set promptCacheTtl 1h",
        usd: 6.8,
        window: "week",
      },
    },
    "feat/checkout",
    NOW,
  );
  const later = renderStatusline(
    payload({
      cost: { total_cost_usd: 11.85, total_duration_ms: 3.1 * H, total_api_duration_ms: 1.4 * H },
      context_window: {
        used_percentage: 71,
        context_window_size: 1_000_000,
        total_input_tokens: 710_000,
      },
    }),
    {
      ...base,
      hasSpendCap: false,
      planType: "claude_pro",
      promptUsd: 0.92,
      cache: cache({
        secondsUntilCold: 52,
        nextWarmUsd: 0.11,
        nextColdUsd: 4.4,
        missPremiumUsd: 4.29,
        expiresAt: sec(52_000),
        requests: 142,
        misses: 3,
        sessionMissUsd: 2.1,
      }),
      rateLimits: limits(86, 64, 1.3 * H, 2.1 * 24 * H),
      runway: {
        fiveHour: {
          usedPct: 86,
          resetsAt: sec(1.3 * H),
          ratePctPerHour: 22,
          exhaustsAt: sec(0.6 * H),
          verdict: "at-risk",
        },
        sevenDay: {
          usedPct: 64,
          resetsAt: sec(2.1 * 24 * H),
          ratePctPerHour: 1.1,
          exhaustsAt: null,
          verdict: "on-track",
        },
      },
      coach: {
        id: "R5",
        title: "Deep context",
        action: "/compact at the next break",
        usd: 14.2,
        window: "week",
      },
    },
    "main",
    NOW,
  );
  return [start, later];
}

export async function enterprise(dist) {
  const { renderStatusline } = await import(`${dist}/statusline-render.js`);
  return [
    renderStatusline(
      payload({
        model: { display_name: "Sonnet 5.5" },
        effort: { level: "medium" },
        cost: { total_cost_usd: 2.16 },
        context_window: {
          used_percentage: 9,
          context_window_size: 1_000_000,
          total_input_tokens: 90_000,
        },
      }),
      {
        ...base,
        hasSpendCap: true,
        planType: "claude_enterprise",
        promptUsd: 0.12,
        rateLimits: {
          fiveHourPct: null,
          sevenDayPct: null,
          fiveHourResetsAt: null,
          sevenDayResetsAt: null,
          source: "none",
        },
        todayUsage: 12.4,
        avgPerDay: 30,
        todayUsedPct: 0.41,
        budgetExhausted: false,
        monthlySpent: 318,
        monthlyCap: 600,
        monthUsedPct: 0.53,
        ledgerAgeMs: null,
        capSource: "anthropic",
        coach: {
          id: "R1",
          title: "Subagents on a premium model",
          action: "CLAUDE_CODE_SUBAGENT_MODEL=sonnet",
          usd: 9.3,
          window: "week",
        },
      },
      "fix/invoice-rounding",
      NOW,
    ),
  ];
}
