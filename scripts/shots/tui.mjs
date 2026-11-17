// Full-screen shots: live, calendar, settings. Made-up data, fixed clock.
// The runner gives each shot a throwaway HOME: the calendar reads ~/.config/cc-spend.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const NOW = Date.parse("2026-11-16T15:20:00.000Z");
const iso = (ms) => new Date(NOW + ms).toISOString();

export async function live(dist) {
  const { renderLive } = await import(`${dist}/live-render.js`);
  const { addSessionTurn, newSession } = await import(`${dist}/session-model.js`);
  let n = 0;
  const turn = (fields) => ({
    key: `k${String(++n)}`,
    sessionId: "s",
    timestamp: iso(-60_000),
    model: "claude-opus-5-5",
    cwd: "/work/shop-api",
    branch: "feat/checkout",
    fast: false,
    usOnly: false,
    input: 800,
    output: 1400,
    cacheRead: 60_000,
    cacheWrite5m: 1200,
    cacheWrite1h: 0,
    thinking: 0,
    webSearches: 0,
    webFetches: 0,
    effort: null,
    thinkingMs: 0,
    entrypoint: null,
    ...fields,
  });
  const session = (id, cwd, branch, count, spanMin, growK, model, agoMin) => {
    const s = newSession(id);
    for (let i = 0; i < count; i++) {
      const at = -(spanMin + agoMin) * 60_000 + (i * spanMin * 60_000) / count;
      const sub = i % 7 === 3;
      addSessionTurn(
        s,
        turn({
          sessionId: id,
          cwd,
          branch,
          timestamp: iso(at),
          cacheRead: 40_000 + i * growK * 1000,
          cacheWrite5m: i === 22 ? 180_000 : 1500,
          model,
        }),
        sub ? "subagent:Explore" : "main",
        sub ? `t${String(i)}` : "main",
      );
    }
    return s;
  };
  const sessions = [
    session("a1f3c9e2", "/work/shop-api", "feat/checkout", 64, 28, 3, "claude-opus-5-5", 0),
    session("7b20d4aa", "/work/web-app", "main", 30, 90, 2, "claude-sonnet-5-5", 14),
    session("c99e0f17", "/work/infra", "fix/tf-drift", 18, 50, 1, "claude-sonnet-5-5", 95),
  ];
  const feed = {
    kind: "ok",
    feed: {
      schemaVersion: 1,
      writtenAt: iso(-30_000),
      accountKey: "demo",
      plan: { organizationType: "claude_pro", hasSpendCap: false },
      sessionIds: [],
      limits: {
        fiveHour: {
          usedPct: 34,
          resetsAt: iso(2.6 * 3_600_000),
          ratePctPerHour: 9,
          exhaustsAt: null,
          verdict: "comfortable",
        },
        sevenDay: {
          usedPct: 21,
          resetsAt: iso(4.2 * 86_400_000),
          ratePctPerHour: 0.4,
          exhaustsAt: null,
          verdict: "on-track",
        },
        usdPerPercentWeek: 2.4,
        claudeCodeShare: null,
      },
      spend: { today: 18.4, week: 96, monthToDate: 310, last30Days: 400, isFloor: false },
      advice: [
        {
          id: "R13",
          title: "Cache expires in breaks",
          why: "a 5-60 min break re-writes the whole context",
          action: "set promptCacheTtl 1h",
          usd: 6.8,
          weekPct: 2.8,
          window: "week",
          evidence: "9 breaks of 5-60 min this week",
          fix: { kind: "setting", key: "promptCacheTtl", value: "1h" },
          snoozedUntil: null,
        },
        {
          id: "R1",
          title: "Subagents on a premium model",
          why: "subagents bill the same tokens at 2-5x Sonnet",
          action: "CLAUDE_CODE_SUBAGENT_MODEL=sonnet",
          usd: 4.1,
          weekPct: 1.7,
          window: "week",
          evidence: "Explore ran on Opus 5.5",
          fix: { kind: "env", key: "CLAUDE_CODE_SUBAGENT_MODEL", value: "sonnet" },
          snoozedUntil: null,
        },
      ],
    },
  };
  const lines = renderLive({
    sessions,
    selected: 0,
    feed,
    nowMs: NOW,
    width: 110,
    height: 40,
    color: true,
    view: "advisor",
  });
  return [lines.join("\n")];
}

export async function calendar(dist) {
  const cal = await import(`${dist}/calendar-tui.js`);
  const { accountKey } = await import(`${dist}/account.js`);
  const account = {
    email: "demo@example.com",
    accountUuid: "uuid-demo",
    organizationType: "claude_enterprise",
  };
  const dir = path.join(homedir(), ".config", "cc-spend", "accounts", accountKey(account));
  mkdirSync(dir, { recursive: true });
  const work = [2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 16, 17, 18, 19, 20, 23, 24, 25, 26, 27, 30];
  const spentPerDay = [24, 31, 18, 29, 22, 35, 27, 26, 30, 28];
  const days = {};
  work
    .filter((day) => day < 16)
    .forEach((day, i) => {
      days[`2026-11-${String(day).padStart(2, "0")}`] = spentPerDay[i] ?? 25;
    });
  const laboral = work.filter((day) => day !== 11 && day !== 27);
  writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ monthlyCap: 600, laboralDays: { 2026: { 11: laboral } }, hasSpendCap: true }),
  );
  const spent = Object.values(days).reduce((a, b) => a + b, 0);
  writeFileSync(
    path.join(dir, "usage.json"),
    JSON.stringify({
      schemaVersion: 2,
      monthlySpent: spent,
      periodFrozen: spent - 12.4,
      lastUpdated: new Date(NOW).toISOString(),
      days,
      sessions: {},
    }),
  );
  const snapshot = cal.computeSnapshot(account, new Date(NOW));
  return [cal.renderCalendar(cal.initialModel(snapshot), { color: true }).join("\n")];
}

export async function settings(dist) {
  const { initialSettings, renderSettings } = await import(`${dist}/settings-tui.js`);
  const { DEFAULT_LAYOUT } = await import(`${dist}/statusline-layout.js`);
  return [renderSettings(initialSettings(DEFAULT_LAYOUT), { color: true }).join("\n")];
}
