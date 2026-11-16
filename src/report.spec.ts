import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type * as NodeOs from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ReportModule from "./report.js";

let fakeHome: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, homedir: () => fakeHome };
});

function fresh(): Promise<typeof ReportModule> {
  return import("./report.js");
}

const NOW = new Date("2026-10-07T12:00:00.000Z");

function line(id: string, fields: Record<string, unknown> = {}, model = "claude-opus-5-5"): string {
  return `${JSON.stringify({
    type: "assistant",
    requestId: id,
    sessionId: "s1",
    timestamp: "2026-10-07T10:00:00.000Z",
    cwd: "/work/app",
    message: {
      id,
      model,
      usage: {
        input_tokens: 1_000_000,
        output_tokens: 100_000,
        output_tokens_details: { thinking_tokens: 50_000 },
        server_tool_use: { web_search_requests: 1 },
      },
    },
    ...fields,
  })}\n`;
}

function sessionsMap(sessions: Record<string, number>): void {
  const dir = path.join(fakeHome, ".config", "cc-spend", "accounts", "acct");
  mkdirSync(dir, { recursive: true });
  const at = NOW.toISOString();
  writeFileSync(
    path.join(dir, "sessions-map.json"),
    JSON.stringify({
      schemaVersion: 1,
      sessions: Object.fromEntries(
        Object.entries(sessions).map(([id, costUsd]) => [
          id,
          {
            transcriptPath: null,
            firstSeenAt: at,
            lastSeenAt: at,
            costUsd,
            linesAdded: 0,
            linesRemoved: 0,
          },
        ]),
      ),
    }),
  );
}

async function indexFixtures(): Promise<void> {
  const dir = path.join(fakeHome, ".claude", "projects", "-work-app");
  const agents = path.join(dir, "s1", "subagents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(
    path.join(dir, "s1.jsonl"),
    line("a") +
      line("b", { timestamp: "2026-09-20T10:00:00.000Z" }) +
      line("c", { cwd: "/work/lib" }, "claude-sonnet-5-5"),
  );
  writeFileSync(path.join(agents, "agent-x.jsonl"), line("d"));
  writeFileSync(path.join(agents, "agent-x.meta.json"), JSON.stringify({ agentType: "Explore" }));
  writeFileSync(path.join(dir, "s9.jsonl"), line("e", { sessionId: "s9" }, "claude-future-9"));
  const { runIndexPass } = await import("./transcript-index.js");
  runIndexPass({ now: NOW });
}

beforeEach(() => {
  vi.resetModules();
  fakeHome = mkdtempSync(path.join(tmpdir(), "ccs-report-"));
  vi.stubEnv("TZ", "UTC");
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("ranges", () => {
  it("resolves every period to local days and the months it touches", async () => {
    const { resolveRange, monthsOf } = await fresh();
    expect(resolveRange("today", NOW)).toEqual({
      label: "today",
      from: "2026-10-07",
      to: "2026-10-07",
    });
    expect(resolveRange("week", NOW)).toMatchObject({ from: "2026-10-01", to: "2026-10-07" });
    expect(resolveRange("30d", NOW)).toMatchObject({ from: "2026-09-08" });
    expect(resolveRange("month", NOW)).toMatchObject({ label: "2026-10", from: "2026-10-01" });
    expect(resolveRange("2026-02", NOW)).toEqual({
      label: "2026-02",
      from: "2026-02-01",
      to: "2026-02-31",
    });
    expect(resolveRange("2026-13", NOW)).toBeNull();
    expect(resolveRange("soon", NOW)).toBeNull();
    expect(monthsOf({ label: "", from: "2025-11-20", to: "2026-02-01" })).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
  });

  it("uses the local day in other zones", async () => {
    vi.stubEnv("TZ", "Pacific/Auckland");
    const { resolveRange } = await fresh();
    expect(resolveRange("today", NOW)?.from).toBe("2026-10-08");
  });
});

describe("formatReport", () => {
  async function base(): Promise<ReportModule.Report> {
    const { emptyRollup } = await import("./transcript-parse.js");
    const total = {
      ...emptyRollup(),
      usdInput: 10,
      usdNewWork: 5,
      usdCarry: 4,
      usdRewrite: 1,
      growth: 100_000,
      usdThinking: 2,
    };
    return {
      owner: "acct",
      range: { label: "last 7 days", from: "2026-10-01", to: "2026-10-07" },
      by: "model",
      rows: [
        {
          label: "claude-opus-5-5",
          rollup: { ...total, usdInput: 8, usdNewWork: 4, usdCarry: 3, usdRewrite: 1 },
        },
        {
          label: "claude-sonnet-5-5",
          rollup: { ...total, usdInput: 2, usdNewWork: 1, usdCarry: 1, usdRewrite: 0 },
        },
      ],
      total,
      subagentUsd: 1,
      unattributedUsd: 0,
      gaps: [],
      activity: {
        turnMs: 0,
        thinkingMs: 0,
        hookRuns: 0,
        entrypoints: {},
        attributedUsd: {},
        apiErrors: {},
      },
      claudeCode: null,
      daily: [
        ["2026-10-01", 1],
        ["2026-10-02", 0],
        ["2026-10-03", 4],
        ["2026-10-04", 5],
      ],
      previousUsd: 20,
    };
  }

  it("total and trend, $ per day, what the $ paid for, a bar per row, extras and notes", async () => {
    const { formatReport } = await fresh();
    const report = await base();
    expect(formatReport(report)).toMatchInlineSnapshot(`
      "LAST 7 DAYS  Oct 1 → Oct 4   $10   ≈ $2.50/day   ▼ 50% vs the 4 days before
      ▂▁▇█  $ per day

      WHAT THE $ PAID FOR
        ████████████████████████▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▒▒▒▒▒
        █ new work 50%   ▓ history re-reads 40%   ▒ cache rebuilds 10%

      BY MODEL
        opus-5-5    ███████████████▓▓▓▓▓▓▓▓▓▓▓▒▒▒▒  $8.00   80%
        sonnet-5-5  ████▓▓▓▓                        $2.00   20%

      thinking $2.00 · subagents $1.00 (10%)
      API-equivalent estimate, not a bill · what to change: cc-spend insights"
    `);
    const busy = formatReport({
      ...report,
      previousUsd: 5,
      total: { ...report.total, webSearches: 2, unpricedTurns: 1 },
      unattributedUsd: 3,
      gaps: ["a gap"],
      claudeCode: { sessions: 3, claudeCodeUsd: 11, transcriptUsd: 10 },
      activity: {
        ...report.activity,
        turnMs: 11_520_000,
        attributedUsd: {
          "skill:claude-api": 12.4,
          "mcp:tokensave": 3.1,
          "skill:a": 0.5,
          "skill:b": 0.4,
          "skill:tiny": 0.001,
        },
        apiErrors: { "529": 1, "429 usage_limit_reached": 8 },
      },
    });
    expect(busy).toContain("▲ 100% vs the 4 days before");
    expect(busy).toContain(
      "thinking $2.00 · subagents $1.00 (10%) · 2 web searches $0.02 · 3h12m working · 8 requests hit the usage limit · 1 API error",
    );
    expect(busy).toContain("skills & MCP: claude-api $12 · tokensave $3.10 · a $0.50");
    expect(busy).toContain("1 turns on models with no price: totals are a floor.");
    expect(busy).toContain("$3.00 more in sessions no account claimed");
    expect(busy).toContain(
      "Claude Code counted $11 for 3 of these sessions: $1.00 (10%) more than the transcripts show",
    );
    expect(busy).toContain("a gap");
    expect(busy).toMatch(/\$10\+ {3}/); // a floor: unpriced turns
    expect(
      formatReport({ ...report, activity: { ...report.activity, apiErrors: { "529": 2 } } }),
    ).toContain("· 2 API errors");
    expect(formatReport({ ...report, previousUsd: 10 })).toContain("≈ 0% vs the 4 days before");
    expect(formatReport({ ...report, previousUsd: 0 })).not.toContain("days before");
    expect(formatReport(report, { color: true })).toContain("\x1b[38;2;80;220;120m▼ 50%");
    expect(formatReport({ ...report, rows: [] })).toBe("No usage in last 7 days.");
    const time = (turnMs: number): string =>
      formatReport({ ...report, activity: { ...report.activity, turnMs } });
    expect(time(30_000)).toContain("<1m working");
    expect(time(2_400_000)).toContain("40m working");
    expect(formatReport({ ...report, daily: [] })).toMatch(/^LAST 7 DAYS {2}Oct 1 → Oct 7 /); // nothing up to today yet
    const withClaudeCode = (claudeCodeUsd: number, transcriptUsd: number): string =>
      formatReport({ ...report, claudeCode: { sessions: 3, claudeCodeUsd, transcriptUsd } });
    expect(withClaudeCode(1, 0)).toContain("$1.00 (100%) more");
    expect(withClaudeCode(10.005, 10)).not.toContain("Claude Code counted");
  });

  it("no split: no paid-for bar; one day: no sparkline; by day in time order; long lists cut", async () => {
    const { formatReport } = await fresh();
    const report = await base();
    const plain = { ...report.total, usdNewWork: 0, usdCarry: 0, usdRewrite: 0 };
    const text = formatReport({ ...report, total: plain, daily: [["2026-10-01", 10]] });
    expect(text).not.toContain("WHAT THE $ PAID FOR");
    expect(text).not.toContain("$ per day");
    const byDay = formatReport({
      ...report,
      by: "day",
      rows: [
        { label: "2026-10-07", rollup: report.total },
        { label: "2026-10-06", rollup: { ...report.total, usdInput: 0 } },
      ],
    }).split("\n");
    const rows = byDay.slice(byDay.indexOf("BY DAY") + 1);
    expect(rows[0]).toMatch(/^ {2}2026-10-06 +\$0\.00 +0%$/); // a $0 day has no bar
    expect(rows[1]).toMatch(/^ {2}2026-10-07 /);
    const many = formatReport({
      ...report,
      by: "project",
      rows: Array.from({ length: 17 }, (_, i) => ({
        label: `p${String(i)}`,
        rollup: report.total,
      })),
    });
    expect(many).toContain("… 2 more (--json for all)");
    expect(many).toContain("  p0 ");
  });

  it("--by session: plain bars with the share of the 7d limit and $ per 100 lines", async () => {
    const { formatReport } = await fresh();
    const report = await base();
    const { emptyRollup } = await import("./transcript-parse.js");
    const text = formatReport({
      ...report,
      by: "session",
      rows: [
        {
          label: "s1 app",
          rollup: { ...emptyRollup(), usdInput: 8 },
          weekPct: 3.2,
          usdPer100Lines: 1.5,
        },
        {
          label: "s2 lib",
          rollup: { ...emptyRollup(), usdInput: 2 },
          weekPct: null,
          usdPer100Lines: null,
        },
      ],
    });
    expect(text).toMatch(/s1 app +█{30} +\$8\.00 +80% {2}≈3\.2% of 7d limit · \$1\.50\/100 lines/);
    expect(text).toMatch(/s2 lib +█{8} +\$2\.00 +20%$/m);
  });
});

describe("dayBreakdown", () => {
  it("one day's $ with top sessions, models and projects; empty for a day with nothing", async () => {
    sessionsMap({ s1: 1 });
    await indexFixtures();
    const { dayBreakdown } = await fresh();
    const day = dayBreakdown("acct", "2026-10-07");
    expect(day.usd).toBeGreaterThan(0);
    expect(day.models.map(([model]) => model)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
    expect(day.projects.map(([project]) => project)).toEqual(["app", "lib"]);
    expect(day.sessions.map(([label]) => label)).toEqual(["s1 app"]);
    expect(dayBreakdown("acct", "2026-01-01")).toEqual({
      day: "2026-01-01",
      usd: 0,
      sessions: [],
      models: [],
      projects: [],
    });
    expect(dayBreakdown("unattributed", "2026-10-07").sessions.length).toBeGreaterThanOrEqual(0);
  });
});

describe("--by session extras", () => {
  it("$ per 100 changed lines; a session no account map knows", async () => {
    sessionsMap({ s1: 1 });
    await indexFixtures();
    const file = path.join(
      fakeHome,
      ".config",
      "cc-spend",
      "accounts",
      "acct",
      "sessions-map.json",
    );
    const map = JSON.parse(readFileSync(file, "utf8")) as {
      sessions: Record<string, { linesAdded: number }>;
    };
    (map.sessions.s1 as { linesAdded: number }).linesAdded = 200;
    writeFileSync(file, JSON.stringify(map));
    const { buildReport, formatReport, resolveRange } = await fresh();
    const week = resolveRange("week", NOW);
    if (!week) throw new Error("range");
    const report = buildReport("acct", week, "session");
    const usd = report.rows[0]?.rollup.usdInput ?? 0;
    expect(report.rows[0]?.usdPer100Lines).toBeCloseTo(usd / 2);
    expect(formatReport(report)).toContain(
      `$${usd / 2 >= 10 ? (usd / 2).toFixed(0) : (usd / 2).toFixed(2)}/100 lines`,
    );
    const unclaimed = buildReport("unattributed", week, "session");
    expect(unclaimed.rows.every((row) => row.usdPer100Lines === null)).toBe(true);
  });
});

describe("parseReportArgs", () => {
  it("defaults, flags and errors", async () => {
    const { parseReportArgs } = await fresh();
    expect(parseReportArgs([])).toEqual({
      period: "week",
      by: "model",
      json: false,
      account: null,
      session: null,
    });
    expect(parseReportArgs(["2026-09", "--by", "day", "--json", "--account", "k"])).toEqual({
      period: "2026-09",
      by: "day",
      json: true,
      account: "k",
      session: null,
    });
    expect(parseReportArgs(["--session", "ab12"])).toMatchObject({ session: "ab12" });
    expect(parseReportArgs(["--chart"])).toBe("Unknown report argument: --chart"); // the chart is the default
    expect(parseReportArgs(["--session"])).toContain("--session needs a session id");
    expect(parseReportArgs(["--by", "colour"])).toContain("--by needs one of");
    expect(parseReportArgs(["--by"])).toContain("--by needs one of");
    expect(parseReportArgs(["--account"])).toBe("--account needs an account key");
    expect(parseReportArgs(["--nope"])).toBe("Unknown report argument: --nope");
  });
});

describe("buildReport / formatReport", () => {
  it("groups by each dimension, ranks by $, notes subagents, unattributed and unpriced", async () => {
    sessionsMap({ s1: 3 * 6 });
    await indexFixtures();
    const { buildReport, formatReport, resolveRange } = await fresh();
    const week = resolveRange("week", NOW);
    if (!week) throw new Error("range");

    const byModel = buildReport("acct", week, "model");
    expect(byModel.rows.map((row) => row.label)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
    expect(byModel.subagentUsd).toBeCloseTo(6.01); // + one web search
    expect(byModel.unattributedUsd).toBeCloseTo(0.01); // unpriced model: only its web search has a price
    const text = formatReport(byModel);
    expect(text).toContain("API-equivalent estimate");
    expect(text).toMatch(/subagents \$6\.01 \(4\d%\)/);
    expect(text).toContain("thinking $");
    expect(byModel.daily.map(([day]) => day)).toEqual([
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
    ]);
    expect(byModel.previousUsd).toBe(0); // nothing indexed in the 7 days before
    expect(
      buildReport("acct", week, "model", null, new Date("2026-10-03T12:00:00Z")).daily,
    ).toHaveLength(3);
    const september = resolveRange("2026-09", NOW);
    if (!september) throw new Error("range");
    expect(buildReport("acct", september, "day").daily).toHaveLength(30); // stops at Sep 30
    expect(
      buildReport("acct", week, "model", null, new Date("2026-10-30T12:00:00Z")).previousUsd,
    ).toBe(0);
    expect(
      buildReport("acct", { label: "x", from: "2026-09-27", to: "2026-10-03" }, "model")
        .previousUsd,
    ).toBeGreaterThan(0); // Sep 20 is in the 7 days before

    expect(buildReport("acct", week, "project").rows.map((row) => row.label)).toEqual([
      "app",
      "lib",
    ]);
    expect(buildReport("acct", week, "subagent").rows.map((row) => row.label)).toEqual([
      "main",
      "Explore",
    ]);
    expect(buildReport("acct", week, "day").rows.map((row) => row.label)).toEqual(["2026-10-07"]);
    expect(buildReport("acct", week, "component").rows.map((row) => row.label)).toEqual([
      "input",
      "output",
      "cache read",
      "cache write",
    ]);
    expect(buildReport("acct", week, "session").rows[0]?.label).toBe("s1 app");

    // --by session: share of the week from $ per 1%, $ per 100 changed lines from the statusline map
    const sessions = buildReport("acct", week, "session", 2);
    expect(sessions.rows[0]?.weekPct).toBeCloseTo((sessions.rows[0]?.rollup.usdInput ?? 0) / 2);
    expect(sessions.rows[0]?.usdPer100Lines).toBeNull(); // no lines changed
    expect(formatReport(sessions)).toMatch(/s1 app .*≈\d+\.\d% of 7d limit$/m);
    expect(buildReport("acct", week, "session", 0).rows[0]?.weekPct).toBeNull();
    expect(buildReport("acct", week, "session").rows[0]?.weekPct).toBeNull();
    expect(byModel.activity).toEqual({
      turnMs: 0,
      thinkingMs: 0,
      hookRuns: 0,
      entrypoints: {},
      attributedUsd: {},
      apiErrors: {},
    });
    expect(text).not.toContain("working");

    const month = resolveRange("30d", NOW);
    if (!month) throw new Error("range");
    expect(buildReport("acct", month, "day").rows).toHaveLength(2);

    const stray = buildReport("unattributed", week, "model");
    expect(stray.rows[0]?.rollup.unpricedTurns).toBe(1);
    expect(stray.gaps).toEqual([]);
    expect(formatReport(stray)).toContain("totals are a floor");
  });

  it("a session row uses Claude Code's session name; activity counts sessions in range", async () => {
    sessionsMap({ s1: 1 });
    const mapFile = path.join(
      fakeHome,
      ".config",
      "cc-spend",
      "accounts",
      "acct",
      "sessions-map.json",
    );
    const map = JSON.parse(readFileSync(mapFile, "utf8")) as {
      sessions: Record<string, Record<string, unknown>>;
    };
    map.sessions.s1 = { ...map.sessions.s1, name: "fix login" };
    writeFileSync(mapFile, JSON.stringify(map));
    const dir = path.join(fakeHome, ".claude", "projects", "-work-app");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "s1.jsonl"),
      line("a", {
        entrypoint: "cli",
        thinkingDurationMs: 60_000,
        attributionSkill: "claude-api",
        attributionMcpServer: "tokensave",
      }) +
        `${JSON.stringify({ type: "system", subtype: "turn_duration", sessionId: "s1", durationMs: 120_000 })}\n` +
        `${JSON.stringify({ type: "assistant", sessionId: "s1", requestId: "r9", uuid: "u9", isApiErrorMessage: true, apiErrorStatus: 429, apiError: "rate_limit", message: { model: "<synthetic>", usage: {} } })}\n` +
        `${JSON.stringify({ type: "assistant", sessionId: "s1", requestId: "r9", uuid: "u9", isApiErrorMessage: true, apiErrorStatus: 429, apiError: "rate_limit", message: { model: "<synthetic>", usage: {} } })}\n` +
        `${JSON.stringify({ type: "assistant", sessionId: "s1", uuid: "u10", isApiErrorMessage: true })}\n`,
    );
    const { runIndexPass } = await import("./transcript-index.js");
    runIndexPass({ now: NOW });
    const { buildReport, resolveRange } = await fresh();
    const week = resolveRange("week", NOW);
    if (!week) throw new Error("range");
    const report = buildReport("acct", week, "session");
    expect(report.rows[0]?.label).toBe("s1 fix login");
    expect(report.activity).toEqual({
      turnMs: 120_000,
      thinkingMs: 60_000,
      hookRuns: 0,
      entrypoints: { cli: 1 },
      attributedUsd: {
        "skill:claude-api": report.activity.attributedUsd["skill:claude-api"],
        "mcp:tokensave": report.activity.attributedUsd["skill:claude-api"],
      },
      apiErrors: { "429 rate_limit": 1, error: 1 }, // the repeated line counts once
    });
    expect(report.activity.attributedUsd["skill:claude-api"]).toBeGreaterThan(0);
  });

  it("activityOf counts a session from an older index as zero time", async () => {
    const { activityOf } = await fresh();
    const legacy = {
      firstAt: "",
      lastAt: "",
      project: "",
      branch: "",
      models: [],
      turns: 1,
      usd: 0,
      unpricedTurns: 0,
      subagentUsd: 0,
    };
    expect(activityOf([legacy])).toEqual({
      turnMs: 0,
      thinkingMs: 0,
      hookRuns: 0,
      entrypoints: {},
      attributedUsd: {},
      apiErrors: {},
    });
  });

  it("self-check: Claude Code's own $ per model and run against the table's price of the same tokens", async () => {
    const { selfCheck, resolveRange, claudeCodeTotals } = await fresh();
    const week = resolveRange("week", NOW);
    if (!week) throw new Error("range");
    // 1M fresh input + 100k output on Opus 5.5 ($4 / $20): $6.00 at the table's prices.
    const usage = {
      input: 1_000_000,
      output: 100_000,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheWriteOther: 0,
      webSearches: 0,
      usd: 6,
    };
    const session = (
      models: Record<string, typeof usage>,
      lastAt = NOW.toISOString(),
      start = "1",
    ) => ({
      firstAt: "",
      lastAt,
      project: "",
      branch: "",
      models: Object.keys(models),
      turns: 1,
      usd: 6,
      unpricedTurns: 0,
      subagentUsd: 0,
      ccRuns: { [start]: { usd: 6, models } },
    });
    expect(selfCheck({ a: session({ "claude-opus-5-5": usage }) }, week)).toEqual([]);
    // The newest run per model decides: an older Claude Code's price gap is history.
    expect(
      selfCheck(
        {
          old: session({ "claude-opus-5-5": { ...usage, usd: 9 } }, undefined, "1"),
          now: session({ "claude-opus-5-5": usage }, undefined, "2"),
        },
        week,
      ),
    ).toEqual([]);
    expect(
      selfCheck(
        {
          a: session({ "claude-opus-5-5": { ...usage, usd: 7.5 } }, undefined, "3"),
          b: session({ "claude-opus-5-5": { ...usage, usd: 6.5 } }, undefined, "2"),
          c: session({ "claude-sonnet-5-5": { ...usage, usd: 2 } }),
        },
        week,
      ),
    ).toEqual([
      "Claude Code prices claude-opus-5-5 20% higher than this table: a price change, or fast mode.",
      "Claude Code prices claude-sonnet-5-5 50% lower than this table: a price change, or fast mode.",
    ]);
    // Out of range, tiny, unpriced, prompt-tiered (Haiku 5.5) or no runs: nothing to compare.
    expect(
      selfCheck(
        {
          old: session({ "claude-opus-5-5": { ...usage, usd: 1 } }, "2026-01-01T00:00:00.000Z"),
          tiny: session({ "claude-opus-5-5": { ...usage, input: 0, output: 0, usd: 0.05 } }),
          unknown: session({ "claude-next-1": { ...usage, usd: 1 } }),
          haiku: session({ "claude-haiku-5-5": { ...usage, usd: 1 } }),
          none: { ...session({}), ccRuns: undefined },
        },
        week,
      ),
    ).toEqual([]);
    // Every cache-write kind and web searches count: 5m and untagged at 1.25×, 1h at 2× input.
    const writes = {
      ...usage,
      input: 0,
      output: 0,
      cacheRead: 1_000_000,
      cacheWrite5m: 1_000_000,
      cacheWrite1h: 1_000_000,
      cacheWriteOther: 1_000_000,
      webSearches: 10,
      usd: 0.2 + 5 + 8 + 5 + 0.1,
    };
    expect(selfCheck({ w: session({ "claude-opus-5-5": writes }) }, week)).toEqual([]);

    const start = Date.parse("2026-10-09T08:00:00.000Z");
    const counted = {
      ...session({}),
      firstAt: "2026-10-09T09:00:00.000Z",
      usd: 10,
      ccRuns: {
        [String(start)]: { usd: 8, models: {} },
        [String(start + 3_600_000 * 5)]: { usd: 3.5, models: {} },
      },
    };
    expect(claudeCodeTotals([counted])).toEqual({
      sessions: 1,
      claudeCodeUsd: 11.5,
      transcriptUsd: 10,
    });
    // A run that started after the first turn, or runs that add up to less: not counted whole.
    expect(claudeCodeTotals([{ ...counted, firstAt: "2026-10-09T07:00:00.000Z" }])).toBeNull();
    expect(claudeCodeTotals([{ ...counted, usd: 20 }])).toBeNull();
    expect(claudeCodeTotals([{ ...counted, ccRuns: undefined }])).toBeNull();
  });

  it("an account sees the unattributed $ as a note; an empty range says so", async () => {
    const dir = path.join(fakeHome, ".claude", "projects", "-p");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "s5.jsonl"), line("z", { sessionId: "s5" }));
    const { runIndexPass } = await import("./transcript-index.js");
    runIndexPass({ now: NOW });
    const { buildReport, formatReport, resolveRange, hasUnpricedTurns } = await fresh();
    const week = resolveRange("week", NOW);
    if (!week) throw new Error("range");
    const report = buildReport("acct", week, "model");
    expect(report.unattributedUsd).toBeCloseTo(6.01);
    expect(formatReport(report)).toMatch(/^No usage in last 7 days\./);
    const withRows = { ...report, rows: [{ label: "x", rollup: report.total }] };
    expect(formatReport(withRows)).toContain("$6.01 more in sessions no account claimed");
    expect(hasUnpricedTurns("acct", NOW)).toBe(false);
    expect(formatReport({ ...withRows, unattributedUsd: 0 })).not.toContain("subagents");
  });

  it("hasUnpricedTurns sees an unpriced model in the last 30 days", async () => {
    sessionsMap({ s9: 0 });
    await indexFixtures();
    const { hasUnpricedTurns } = await fresh();
    expect(hasUnpricedTurns("acct", NOW)).toBe(true);
  });

  it("a row with no project path shows (unknown)", async () => {
    sessionsMap({ s1: 0 });
    const dir = path.join(fakeHome, ".claude", "projects", "-p");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "s1.jsonl"),
      line("q", { cwd: "" }) +
        line("r", {}, "claude-opus-5-5").replace('"usage":{', '"usage":{"speed":"fast",'),
    );
    const { runIndexPass } = await import("./transcript-index.js");
    runIndexPass({ now: NOW });
    const { buildReport, resolveRange } = await fresh();
    const week = resolveRange("week", NOW);
    if (!week) throw new Error("range");
    expect(
      buildReport("acct", week, "project")
        .rows.map((row) => row.label)
        .sort(),
    ).toEqual(["(unknown)", "app"]);
    expect(buildReport("acct", week, "model").rows.map((row) => row.label)).toContain(
      "claude-opus-5-5 (fast)",
    );
  });
});
