// `record` and `insights` shots. Made-up data; the rule titles, why and fixes come from the real catalog.

const H = 3_600_000;

export async function record(dist) {
  const { emptyRecords, formatRecord } = await import(`${dist}/record.js`);
  const snap = (fields) => ({
    days: 7,
    isFloor: false,
    output: 0,
    subagentUsd: 0,
    turns: 140,
    sessions: 22,
    activeMs: 7 * 2.5 * H,
    peak5h: 62,
    peak7d: 71,
    habits: { prompt: 120, interrupt: 4, clear: 15, model: 9, compact: 6, autoCompact: 2 },
    ...fields,
    models: { "claude-opus-5-5": fields.usd * 0.9, "claude-sonnet-5-5": fields.usd * 0.1 },
  });
  const start = snap({
    from: "2026-10-29",
    to: "2026-11-04",
    usd: 240,
    input: 8,
    cacheRead: 78,
    cacheWrite: 14,
    growth: 6_000_000,
    usdCarry: 130,
    usdRewrite: 60,
    rules: { R11: 60, R5: 30, R4: 20, R10: 12 },
  });
  const week1 = snap({
    from: "2026-11-05",
    to: "2026-11-11",
    usd: 205,
    input: 6,
    cacheRead: 84,
    cacheWrite: 10,
    growth: 6_000_000,
    usdCarry: 105,
    usdRewrite: 40,
    rules: { R11: 45, R5: 22, R4: 15, R10: 10 },
  });
  const week2 = snap({
    from: "2026-11-12",
    to: "2026-11-18",
    usd: 180,
    input: 5,
    cacheRead: 88,
    cacheWrite: 7,
    growth: 6_000_000,
    usdCarry: 90,
    usdRewrite: 28,
    rules: { R11: 36, R5: 14, R4: 12, R10: 9 },
  });
  const live = snap({
    from: "2026-11-19",
    to: "2026-11-23",
    days: 5,
    usd: 118,
    input: 4,
    cacheRead: 91,
    cacheWrite: 5,
    growth: 5_000_000,
    usdCarry: 52,
    usdRewrite: 14,
    sessions: 16,
    turns: 105,
    activeMs: 5 * 2.4 * H,
    habits: { prompt: 95, interrupt: 2, clear: 12, model: 5, compact: 5, autoCompact: 1 },
    rules: { R11: 18, R5: 9, R4: 8, R10: 6 },
  });
  const file = {
    ...emptyRecords(),
    baseline: start,
    closed: [
      { n: 1, from: week1.from, to: week1.to, focus: "R11", focusShare: 0.25, snapshot: week1 },
      { n: 2, from: week2.from, to: week2.to, focus: "R11", focusShare: 0.22, snapshot: week2 },
    ],
    current: { n: 3, from: "2026-11-19", to: "2026-11-25", focus: "R11", focusShare: 0.2 },
  };
  return [formatRecord({ file, live, today: "2026-11-23", closedNow: null }, true)];
}

export async function insights(dist) {
  const { formatInsights } = await import(`${dist}/insights.js`);
  const { ruleInfo } = await import(`${dist}/rules.js`);
  const finding = (id, usd, trendUsdPerWeek, evidence, fix) => ({
    id,
    title: ruleInfo(id).title,
    why: ruleInfo(id).why,
    usd,
    window: "week",
    evidence,
    fix,
    snoozedUntil: null,
    trendUsdPerWeek,
  });
  return [
    formatInsights(
      [
        finding("R11", 24, -6, "fresh input is 3.1× the context it added", {
          kind: "habit",
          text: "Avoid long breaks mid-session (/compact before one); do not switch models on a big context",
        }),
        finding(
          "R5",
          13,
          4,
          "context above 200k tokens (deepest 412k): $11 re-read, $2.10 re-written after misses",
          {
            kind: "setting",
            key: "autoCompactWindow",
            value: "200000",
            text: "Auto-compact before 200k (/autocompact 200k)",
          },
        ),
        finding("R1", 8.4, -1.2, "96 subagent turns on claude-opus-5-5", {
          kind: "env",
          key: "CLAUDE_CODE_SUBAGENT_MODEL",
          value: "sonnet",
          text: "Run subagents on Sonnet (or set model: in the agent file)",
        }),
        finding(
          "R7",
          3.2,
          0.2,
          "github ~14.2k tokens, unused in 9 session(s) $2.40; linear ~6.1k tokens, unused in 4 session(s) $0.80",
          {
            kind: "command",
            value: "/mcp",
            text: "Turn off servers a project does not use (/mcp), or remove them from .mcp.json",
          },
        ),
      ],
      "week",
      true,
    ),
  ];
}
