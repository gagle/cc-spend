import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import type * as NodeOs from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Finding } from "./feed.js";
import type * as InsightsModule from "./insights.js";

let fakeHome: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, homedir: () => fakeHome };
});

function fresh(): Promise<typeof InsightsModule> {
  return import("./insights.js");
}

const NOW = new Date("2026-10-07T12:00:00.000Z");

const FINDING: Finding = {
  id: "R2",
  title: "Fast mode",
  usd: 4,
  window: "week",
  evidence: "1 fast turns",
  fix: { kind: "setting", key: "fastMode", value: "false", text: "Turn fast mode off (/fast)" },
  snoozedUntil: null,
};

beforeEach(() => {
  vi.resetModules();
  fakeHome = mkdtempSync(path.join(tmpdir(), "ccs-insights-"));
  vi.stubEnv("TZ", "UTC");
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("parseInsightsArgs", () => {
  it("defaults, window, json, snooze, errors", async () => {
    const { parseInsightsArgs } = await fresh();
    expect(parseInsightsArgs([])).toEqual({
      window: "week",
      json: false,
      rules: false,
      snooze: null,
    });
    expect(parseInsightsArgs(["--month", "--json", "--rules", "--snooze", "R1", "7d"])).toEqual({
      window: "month",
      json: true,
      rules: true,
      snooze: { id: "R1", days: 7 },
    });
    expect(parseInsightsArgs(["--month", "--week"])).toMatchObject({ window: "week" });
    expect(parseInsightsArgs(["--snooze", "R1"])).toContain("--snooze needs");
    expect(parseInsightsArgs(["--snooze"])).toContain("--snooze needs");
    expect(parseInsightsArgs(["--snooze", "x", "7d"])).toContain("--snooze needs");
    expect(parseInsightsArgs(["--nope"])).toBe("Unknown insights argument: --nope");
  });
});

describe("formatInsights", () => {
  it("a total to save, one block per finding with its bar, $, trend and fix; snoozed marked; empty says so", async () => {
    const { formatInsights } = await fresh();
    expect(formatInsights([], "week")).toBe(
      "Nothing to change this week: every habit is on target.",
    );
    const findings: ReadonlyArray<Finding> = [
      { ...FINDING, why: "Fast mode bills every token at 2x.", trendUsdPerWeek: 3 },
      {
        ...FINDING,
        id: "R8",
        title: "Running out early",
        usd: null,
        fix: { kind: "habit", text: "Slow down" },
        snoozedUntil: "2026-10-14T00:00:00.000Z",
      },
      {
        ...FINDING,
        id: "R9",
        title: "Older model",
        usd: 12,
        evidence: `${fakeHome}/x/CLAUDE.md`,
        fix: { kind: "command", value: "/model", text: "Switch with /model" },
        trendUsdPerWeek: -2,
      },
      {
        ...FINDING,
        id: "R1",
        usd: 1,
        fix: { kind: "env", key: "K", text: "t" },
        trendUsdPerWeek: 0.1,
      },
    ];
    expect(formatInsights(findings, "week", false, "your start")).toMatchInlineSnapshot(`
      "YOU COULD SAVE ~$17/week  3 findings · last 7 days

       1  Fast mode          █████             ~$4.00/week  ▲ +$3.00 vs your start
          → Turn fast mode off (/fast)  (fastMode=false)
          1 fast turns
          why: Fast mode bills every token at 2x.

       2  Running out early                    costs time, not $  snoozed until 2026-10-14
          → Slow down
          1 fast turns

       3  Older model        ████████████████  ~$12/week  ▼ −$2.00 vs your start
          → Switch with /model
          ~/x/CLAUDE.md

       4  Fast mode          █                 ~$1.00/week
          → t  (K=)
          1 fast turns

      API-equivalent estimates · every rule: cc-spend insights --rules · hide one: --snooze R1 7d"
    `);
    const colored = formatInsights(findings, "week", true);
    expect(colored).toContain("\x1b[1;38;2;248;105;107m▲ +$3.00 vs last week\x1b[0m");
    expect(colored).toContain("\x1b[1;38;2;80;220;120m▼ −$2.00 vs last week\x1b[0m");
    expect(formatInsights([{ ...FINDING, usd: null }], "month")).toContain("WHAT TO CHANGE");
    expect(formatInsights([FINDING], "month")).toContain("1 finding · last 30 days");
  });

  it("Pro/Max: the $ as points of the 7d limit, `<1` under one point", async () => {
    const { formatInsights } = await fresh();
    expect(formatInsights([{ ...FINDING, weekPct: 2.6 }], "week")).toContain(
      "~$4.00/week ≈3% of 7d limit",
    );
    expect(formatInsights([{ ...FINDING, weekPct: 0.4 }], "week")).toContain(
      "~$4.00/week ≈<1% of 7d limit",
    );
  });
});

describe("formatRules / rulesWithFound", () => {
  it("every rule with checks, why, $ and fix; ● marks the ones found", async () => {
    const { formatRules, rulesWithFound } = await fresh();
    const { RULE_INFO } = await import("./rules.js");
    const text = formatRules([FINDING], "week");
    expect(text).toMatch(/^What cc-spend insights checks, over the last 7 days/);
    expect(text).toContain(
      "● R2  Fast mode\n       checks  Turns run in fast mode.\n       why     ",
    );
    expect(text).toContain("  R1  Subagents on a premium model\n");
    for (const rule of RULE_INFO) {
      expect(text).toContain(rule.why);
      expect(text).toContain(rule.estimate);
      expect(text).toContain(rule.fix);
    }
    expect(formatRules([], "month")).toContain("over the last 30 days");
    expect(rulesWithFound([FINDING]).find((rule) => rule.id === "R2")).toMatchObject({
      found: true,
    });
    expect(rulesWithFound([]).every((rule) => !rule.found)).toBe(true);
  });
});

describe("snoozeRule / adviceFor", () => {
  it("stores and clears a snooze; the coach then puts that finding last", async () => {
    const { snoozeRule, adviceFor } = await fresh();
    const { loadConfig, loadUsage } = await import("./config.js");
    expect(snoozeRule("acct", "R2", 7, NOW)).toBe("2026-10-14T12:00:00.000Z");
    expect(loadConfig("acct").snoozed).toEqual({ R2: "2026-10-14T12:00:00.000Z" });

    const dir = path.join(fakeHome, ".claude", "projects", "-p");
    mkdirSync(dir, { recursive: true });
    const line = (id: string, speed: string, timestamp: string): string =>
      `${JSON.stringify({
        type: "assistant",
        requestId: id,
        sessionId: "s1",
        timestamp,
        cwd: "/p",
        message: { id, model: "claude-opus-5-5", usage: { input_tokens: 1_000_000, speed } },
      })}\n`;
    writeFileSync(
      path.join(dir, "s1.jsonl"),
      line("a", "fast", NOW.toISOString()) + line("b", "fast", "2026-09-01T00:00:00.000Z"),
    );
    const accountDir = path.join(fakeHome, ".config", "cc-spend", "accounts", "acct");
    writeFileSync(
      path.join(accountDir, "sessions-map.json"),
      JSON.stringify({
        schemaVersion: 1,
        sessions: {
          s1: {
            transcriptPath: null,
            firstSeenAt: NOW.toISOString(),
            lastSeenAt: NOW.toISOString(),
            costUsd: 8,
            linesAdded: 0,
            linesRemoved: 0,
          },
        },
      }),
    );
    const { runIndexPass } = await import("./transcript-index.js");
    runIndexPass({ now: NOW });
    const usage = loadUsage("acct", NOW);
    usage.missCauses = {
      "2026-10-07": { tools_changed: { count: 1, usd: 2 } },
      "2026-08-01": { tools_changed: { count: 1, usd: 50 } },
    };
    const feed = {
      limits: { fiveHour: null, sevenDay: null, usdPerPercentWeek: null, claudeCodeShare: null },
    };
    const week = adviceFor("acct", "week", feed, loadConfig("acct"), usage, NOW);
    expect(week.map((finding) => [finding.id, finding.usd, finding.snoozedUntil !== null])).toEqual(
      [
        ["R4", 2, false],
        ["R2", 4, true],
      ],
    );
    const month = adviceFor("acct", "month", feed, loadConfig("acct"), usage, NOW);
    expect(month.find((finding) => finding.id === "R2")?.window).toBe("month");

    expect(snoozeRule("acct", "R2", 0, NOW)).toBeNull();
    expect(loadConfig("acct").snoozed).toEqual({});
    expect(
      adviceFor("acct", "week", feed, { monthlyCap: 1, laboralDays: {} }, usage, NOW)[0]?.id,
    ).toBe("R2");
  });
});

const fs = (file: string): number => statSync(file).size;

describe("instructionFiles", () => {
  it("global CLAUDE.md + its @imports; per project CLAUDE.md variants and MEMORY.md; sizes ÷ 4", async () => {
    const claude = path.join(fakeHome, ".claude");
    mkdirSync(path.join(claude, "rules"), { recursive: true });
    writeFileSync(
      path.join(claude, "CLAUDE.md"),
      "x".repeat(40) + "\n@RULES.md\n@~/rules/a.md\n@missing.md\n",
    );
    writeFileSync(path.join(claude, "RULES.md"), "y".repeat(400));
    mkdirSync(path.join(fakeHome, "rules"), { recursive: true });
    writeFileSync(path.join(fakeHome, "rules", "a.md"), ""); // empty: not counted
    const project = path.join(fakeHome, "work", "app");
    mkdirSync(path.join(project, ".claude"), { recursive: true });
    writeFileSync(path.join(project, "CLAUDE.md"), "z".repeat(8000));
    writeFileSync(path.join(project, ".claude", "CLAUDE.md"), "w".repeat(4));
    const memory = path.join(claude, "projects", project.replace(/[^A-Za-z0-9]/g, "-"), "memory");
    mkdirSync(memory, { recursive: true });
    writeFileSync(path.join(memory, "MEMORY.md"), "m".repeat(10));
    const { instructionFiles } = await fresh();
    const files = instructionFiles([project, ""]);
    expect(
      files.map((file) => [path.relative(fakeHome, file.path), file.project, file.tokens]),
    ).toEqual([
      [".claude/CLAUDE.md", null, Math.ceil(fs(path.join(claude, "CLAUDE.md")) / 4)],
      [".claude/RULES.md", null, 100],
      ["work/app/CLAUDE.md", project, 2000],
      ["work/app/.claude/CLAUDE.md", project, 1],
      [path.relative(fakeHome, path.join(memory, "MEMORY.md")), project, 3],
    ]);
  });

  it("no global file: nothing global", async () => {
    const { instructionFiles } = await fresh();
    expect(instructionFiles([])).toEqual([]);
  });
});
