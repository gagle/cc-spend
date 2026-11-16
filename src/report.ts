import path from "node:path";

import { localDateKey } from "./clock.js";
import { loadSessionsMap } from "./config.js";
import { paint, type Segment, sparkline, stacked } from "./meter.js";
import { cacheWriteRate, hasPromptTiers, ratesFor, tokensCost, WEB_SEARCH_USD } from "./pricing.js";
import { shortDay } from "./record.js";
import {
  loadRollups,
  loadSessionTotals,
  type SessionTotals,
  UNATTRIBUTED,
} from "./transcript-index.js";
import {
  type CcModelUsage,
  emptyRollup,
  mergeRollup,
  parseRowKey,
  type Rollup,
  rollupUsd,
} from "./transcript-parse.js";

export const PERIODS = ["today", "week", "month", "30d"] as const;
export const DIMENSIONS = ["model", "project", "component", "subagent", "session", "day"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/** Local days `from..to` inclusive, as YYYY-MM-DD. */
export interface DayRange {
  readonly label: string;
  readonly from: string;
  readonly to: string;
}

/** `day` + `n` local days, as YYYY-MM-DD. */
function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return localDateKey(new Date(y, m - 1, d + n));
}

const nextDay = (day: string): string => shiftDay(day, 1);

function daysBack(now: Date, back: number): string {
  return localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back));
}

/** `today`, `week` (rolling 7 local days), `month` (local month to date), `30d`, or `YYYY-MM`; null = bad. */
export function resolveRange(period: string, now: Date): DayRange | null {
  const today = localDateKey(now);
  if (period === "today") return { label: "today", from: today, to: today };
  if (period === "week") return { label: "last 7 days", from: daysBack(now, 6), to: today };
  if (period === "30d") return { label: "last 30 days", from: daysBack(now, 29), to: today };
  if (period === "month")
    return { label: today.slice(0, 7), from: `${today.slice(0, 7)}-01`, to: today };
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!match) return null;
  return { label: period, from: `${period}-01`, to: `${period}-31` };
}

/** Months a range touches, `YYYY-MM`. */
export function monthsOf(range: DayRange): ReadonlyArray<string> {
  const months: Array<string> = [];
  let year = Number(range.from.slice(0, 4));
  let month = Number(range.from.slice(5, 7));
  const last = range.to.slice(0, 7);
  for (;;) {
    const key = `${String(year)}-${String(month).padStart(2, "0")}`;
    months.push(key);
    if (key >= last) return months;
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
}

export interface ReportRow {
  readonly label: string;
  readonly rollup: Rollup;
  readonly weekPct?: number | null; // --by session: share of the 7-day limit (needs $ per 1%)
  readonly usdPer100Lines?: number | null; // --by session: $ per 100 changed lines (statusline sessions)
}

export interface Report {
  readonly owner: string;
  readonly range: DayRange;
  readonly by: Dimension;
  readonly rows: ReadonlyArray<ReportRow>; // by $ descending
  readonly total: Rollup;
  readonly subagentUsd: number;
  readonly unattributedUsd: number; // same range, sessions no account claimed
  readonly gaps: ReadonlyArray<string>; // self-check notes
  readonly activity: ReportActivity;
  readonly claudeCode: ClaudeCodeTotals | null; // Claude Code's own $ for the sessions it fully counted
  readonly daily: ReadonlyArray<readonly [string, number]>; // each local day of the range up to today, $
  readonly previousUsd: number; // $ of the same number of days just before the range
}

/** Sessions in range whose every run left a `cost-state` line: Claude Code's $ next to the transcripts' $. */
export interface ClaudeCodeTotals {
  readonly sessions: number;
  readonly claudeCodeUsd: number;
  readonly transcriptUsd: number;
}

/** Time and hook totals of the sessions last active in the range (from Claude Code's system lines). */
export interface ReportActivity {
  readonly turnMs: number;
  readonly thinkingMs: number;
  readonly hookRuns: number;
  readonly entrypoints: Readonly<Record<string, number>>; // how sessions started → session count
  readonly attributedUsd: Readonly<Record<string, number>>; // `skill:<name>` / `mcp:<server>` → $
  readonly apiErrors: Readonly<Record<string, number>>; // `429 usage_limit_reached` → failed requests
}

export function activityOf(sessions: ReadonlyArray<SessionTotals>): ReportActivity {
  const entrypoints: Record<string, number> = {};
  const attributedUsd: Record<string, number> = {};
  const apiErrors: Record<string, number> = {};
  const add = (into: Record<string, number>, from: Readonly<Record<string, number>> = {}): void => {
    for (const [key, value] of Object.entries(from)) into[key] = (into[key] ?? 0) + value;
  };
  let turnMs = 0;
  let thinkingMs = 0;
  let hookRuns = 0;
  for (const session of sessions) {
    turnMs += session.turnMs ?? 0;
    thinkingMs += session.thinkingMs ?? 0;
    hookRuns += session.hookRuns ?? 0;
    add(attributedUsd, session.attributedUsd);
    add(apiErrors, session.apiErrors);
    if (session.entrypoint) {
      entrypoints[session.entrypoint] = (entrypoints[session.entrypoint] ?? 0) + 1;
    }
  }
  return { turnMs, thinkingMs, hookRuns, entrypoints, attributedUsd, apiErrors };
}

/** Rollups of `owner` inside `range`, keyed by row key. */
export function rowsInRange(owner: string, range: DayRange): ReadonlyArray<[string, Rollup]> {
  return [...loadRollups(owner, monthsOf(range))].filter(([key]) => {
    const { day } = parseRowKey(key);
    return day >= range.from && day <= range.to;
  });
}

function labelOf(key: string, by: Exclude<Dimension, "component" | "session">): string {
  const parts = parseRowKey(key);
  if (by === "project") return parts.project === "" ? "(unknown)" : path.basename(parts.project);
  if (by === "subagent")
    return parts.scope === "main" ? "main" : parts.scope.replace("subagent:", "");
  if (by === "day") return parts.day;
  return parts.speed === "fast" ? `${parts.model} (fast)` : parts.model;
}

const COMPONENTS: ReadonlyArray<readonly [string, keyof Rollup]> = [
  ["input", "usdInput"],
  ["output", "usdOutput"],
  ["cache read", "usdCacheRead"],
  ["cache write", "usdCacheWrite"],
];

/** A rollup holding only one $ component (for `--by component`). */
function componentRollup(total: Rollup, field: keyof Rollup): Rollup {
  return { ...emptyRollup(), [field]: total[field] };
}

function lastInRange(session: SessionTotals, range: DayRange): boolean {
  const day = localDateKey(new Date(session.lastAt));
  return day >= range.from && day <= range.to;
}

/** One model's tokens of one run at this table's prices; null for a model the table cannot re-price. */
function tablePrice(model: string, usage: CcModelUsage): number | null {
  const rates = ratesFor(model);
  if (rates === null || hasPromptTiers(model)) return null;
  return (
    tokensCost(usage.input, rates.input) +
    tokensCost(usage.output, rates.output) +
    tokensCost(usage.cacheRead, rates.cacheRead) +
    tokensCost(usage.cacheWrite5m + usage.cacheWriteOther, cacheWriteRate(rates, "5m")) +
    tokensCost(usage.cacheWrite1h, cacheWriteRate(rates, "1h")) +
    usage.webSearches * WEB_SEARCH_USD
  );
}

/**
 * Self-check: Claude Code's own $ per model and run (`cost-state`) against the same tokens at this table's
 * prices. Both price the same tokens, so a gap over 1% (on more than 5 cents) means the table is stale for that
 * model, or the run used fast mode. Haiku 5.5 is skipped: its price depends on each request's prompt size.
 * Only each model's newest run counts: an older Claude Code may have priced a model differently (2.1.293
 * billed Sonnet 5.5 cache reads at $0.20, later builds at $0.10), and that past gap says nothing about the
 * table now.
 */
export function selfCheck(
  totals: Readonly<Record<string, SessionTotals>>,
  range: DayRange,
): ReadonlyArray<string> {
  const newest = new Map<string, { start: number; gap: number }>();
  for (const session of Object.values(totals)) {
    if (!lastInRange(session, range)) continue;
    for (const [startKey, run] of Object.entries(session.ccRuns ?? {})) {
      const start = Number(startKey);
      for (const [model, usage] of Object.entries(run.models)) {
        const table = tablePrice(model, usage);
        if (table === null || usage.usd <= 0.05) continue;
        if (start <= (newest.get(model)?.start ?? Number.NEGATIVE_INFINITY)) continue;
        newest.set(model, { start, gap: (table - usage.usd) / usage.usd });
      }
    }
  }
  return [...newest]
    .flatMap(([model, { gap }]): Array<[string, number]> =>
      Math.abs(gap) > 0.01 ? [[model, gap]] : [],
    )
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([model, gap]) =>
        `Claude Code prices ${model} ${String(Math.round(Math.abs(gap) * 100))}% ${gap < 0 ? "higher" : "lower"} than this table: a price change, or fast mode.`,
    );
}

/**
 * Claude Code's own total next to the transcripts' for the sessions it counted whole: a `cost-state` run
 * starts no later than the first turn, and the runs add up to at least the transcripts' $ (a run that ended
 * without its line would leave less). The difference is requests no transcript line shows.
 */
export function claudeCodeTotals(sessions: ReadonlyArray<SessionTotals>): ClaudeCodeTotals | null {
  let count = 0;
  let claudeCodeUsd = 0;
  let transcriptUsd = 0;
  for (const session of sessions) {
    const runs = Object.entries(session.ccRuns ?? {});
    if (runs.length === 0) continue;
    const firstStart = Math.min(...runs.map(([start]) => Number(start)));
    const usd = runs.reduce((sum, [, run]) => sum + run.usd, 0);
    if (firstStart > Date.parse(session.firstAt) || usd < session.usd * 0.99) continue;
    count += 1;
    claudeCodeUsd += usd;
    transcriptUsd += session.usd;
  }
  return count === 0 ? null : { sessions: count, claudeCodeUsd, transcriptUsd };
}

export function buildReport(
  owner: string,
  range: DayRange,
  by: Dimension,
  usdPerPercentWeek: number | null = null,
  now: Date = new Date(),
): Report {
  const entries = rowsInRange(owner, range);
  const total = emptyRollup();
  let subagentUsd = 0;
  const groups = new Map<string, Rollup>();
  for (const [key, rollup] of entries) {
    mergeRollup(total, rollup);
    if (parseRowKey(key).scope !== "main") subagentUsd += rollupUsd(rollup);
    if (by === "component" || by === "session") continue;
    const label = labelOf(key, by);
    const group = groups.get(label) ?? emptyRollup();
    mergeRollup(group, rollup);
    groups.set(label, group);
  }
  const totals = loadSessionTotals(owner);
  const names = owner === UNATTRIBUTED ? {} : loadSessionsMap(owner);
  const inRange = Object.entries(totals).filter(([, session]) => lastInRange(session, range));
  let rows: Array<ReportRow>;
  if (by === "component") {
    rows = COMPONENTS.map(([label, field]) => ({ label, rollup: componentRollup(total, field) }));
  } else if (by === "session") {
    rows = inRange.map(([id, session]) => {
      const lines = (names[id]?.linesAdded ?? 0) + (names[id]?.linesRemoved ?? 0);
      return {
        label: `${id.slice(0, 8)} ${names[id]?.name ?? path.basename(session.project)}`,
        rollup: { ...emptyRollup(), turns: session.turns, usdInput: session.usd },
        weekPct:
          usdPerPercentWeek && usdPerPercentWeek > 0 ? session.usd / usdPerPercentWeek : null,
        usdPer100Lines: lines > 0 ? session.usd / (lines / 100) : null,
      };
    });
  } else {
    rows = [...groups].map(([label, rollup]) => ({ label, rollup }));
  }
  rows.sort((a, b) => rollupUsd(b.rollup) - rollupUsd(a.rollup));
  const unattributed =
    owner === UNATTRIBUTED
      ? 0
      : rowsInRange(UNATTRIBUTED, range).reduce((sum, [, rollup]) => sum + rollupUsd(rollup), 0);
  const days = new Map<string, number>();
  for (const [key, rollup] of entries) {
    const { day } = parseRowKey(key);
    days.set(day, (days.get(day) ?? 0) + rollupUsd(rollup));
  }
  const today = localDateKey(now);
  const daily: Array<readonly [string, number]> = [];
  // `YYYY-MM` ranges end on day 31; string order stops at the month's real last day (Sep 30 → Oct 1 > Sep 31).
  for (let day = range.from; day <= range.to && day <= today; day = nextDay(day)) {
    daily.push([day, days.get(day) ?? 0]);
  }

  const length = Math.max(1, daily.length);
  const previous = {
    label: "previous",
    from: shiftDay(range.from, -length),
    to: shiftDay(range.from, -1),
  };
  const previousUsd = rowsInRange(owner, previous).reduce(
    (sum, [, rollup]) => sum + rollupUsd(rollup),
    0,
  );
  return {
    owner,
    range,
    by,
    rows,
    total,
    subagentUsd,
    unattributedUsd: unattributed,
    gaps: owner === UNATTRIBUTED ? [] : selfCheck(totals, range),
    activity: activityOf(inRange.map(([, session]) => session)),
    claudeCode: claudeCodeTotals(inRange.map(([, session]) => session)),
    daily,
    previousUsd,
  };
}

/** One local day from the index: its $ and the top sessions (last active that day), models and projects. */
export interface DayBreakdown {
  readonly day: string;
  readonly usd: number;
  readonly sessions: ReadonlyArray<readonly [string, number]>;
  readonly models: ReadonlyArray<readonly [string, number]>;
  readonly projects: ReadonlyArray<readonly [string, number]>;
}

function top3(totals: ReadonlyMap<string, number>): ReadonlyArray<readonly [string, number]> {
  return [...totals]
    .filter(([, usd]) => usd > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
}

export function dayBreakdown(owner: string, day: string): DayBreakdown {
  const models = new Map<string, number>();
  const projects = new Map<string, number>();
  let usd = 0;
  for (const [key, rollup] of rowsInRange(owner, { label: day, from: day, to: day })) {
    const value = rollupUsd(rollup);
    usd += value;
    const model = labelOf(key, "model");
    const project = labelOf(key, "project");
    models.set(model, (models.get(model) ?? 0) + value);
    projects.set(project, (projects.get(project) ?? 0) + value);
  }
  const names = owner === UNATTRIBUTED ? {} : loadSessionsMap(owner);
  const sessions = new Map<string, number>();
  for (const [id, session] of Object.entries(loadSessionTotals(owner))) {
    if (localDateKey(new Date(session.lastAt)) !== day) continue;
    sessions.set(
      `${id.slice(0, 8)} ${names[id]?.name ?? path.basename(session.project)}`,
      session.usd,
    );
  }
  return { day, usd, sessions: top3(sessions), models: top3(models), projects: top3(projects) };
}

/** Whether the account's last 30 days hold a turn with no price (totals are then a floor). */
export function hasUnpricedTurns(owner: string, now: Date): boolean {
  const range = resolveRange("30d", now) as DayRange;
  return rowsInRange(owner, range).some(([, rollup]) => rollup.unpricedTurns > 0);
}

/** Whole $ from $10 up: cents there are noise on an estimate. */
const money = (usd: number): string => (usd >= 10 ? `$${usd.toFixed(0)}` : `$${usd.toFixed(2)}`);

/** `3h12m` / `40m` / `<1m`. */
function hoursMinutes(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  const hours = Math.floor(minutes / 60);
  return hours === 0 ? `${String(minutes)}m` : `${String(hours)}h${String(minutes % 60)}m`;
}

/** The three things a $ pays for (`Rollup` split, rows indexed from 2026-10-18), plus what the split misses. */
const PARTS: ReadonlyArray<{
  readonly rgb: string;
  readonly glyph: string; // without color, so the parts stay apart
  readonly label: string;
  readonly usd: (r: Rollup) => number;
}> = [
  { rgb: "80;200;120", glyph: "█", label: "new work", usd: (r) => r.usdNewWork },
  { rgb: "240;180;80", glyph: "▓", label: "history re-reads", usd: (r) => r.usdCarry },
  { rgb: "230;110;110", glyph: "▒", label: "cache rebuilds", usd: (r) => r.usdRewrite },
  {
    rgb: "110;110;110",
    glyph: "░",
    label: "other",
    usd: (r) => Math.max(0, rollupUsd(r) - r.usdNewWork - r.usdCarry - r.usdRewrite),
  },
];
const ROW_CELLS = 30;
const SPLIT_CELLS = 48;

export interface FormatOptions {
  readonly color: boolean;
}

const pctOf = (part: number, whole: number): string =>
  `${String(whole > 0 ? Math.round((part / whole) * 100) : 0)}%`;

/** Segments of a $ by what it paid for; `other` only when the split leaves something out. */
function segments(r: Rollup): ReadonlyArray<Segment> {
  return PARTS.map((part) => ({ value: part.usd(r), rgb: part.rgb, glyph: part.glyph }));
}

const DIM = (text: string, color: boolean): string => (color ? `\x1b[2m${text}\x1b[0m` : text);
const BOLD = (text: string, color: boolean): string => (color ? `\x1b[1m${text}\x1b[0m` : text);

/** `▼ 12% vs the 7 days before` (green) / `▲ 8% …` (red); empty with nothing before. */
function versus(report: Report, color: boolean): string {
  const now = rollupUsd(report.total);
  if (report.previousUsd <= 0) return "";
  const relative = Math.round(((now - report.previousUsd) / report.previousUsd) * 100);
  const text = `${relative > 0 ? "▲" : relative < 0 ? "▼" : "≈"} ${String(Math.abs(relative))}% vs the ${String(report.daily.length)} days before`;
  if (relative === 0) return DIM(text, color);
  return paint(relative < 0 ? "80;220;120" : "248;105;107", text, color);
}

/** `thinking $16 · subagents $0 (0%) · 12h57m of turns · 8 requests hit the usage limit`, and the skills/MCP
 * Claude Code attributed $ to. */
function extraLines(report: Report): ReadonlyArray<string> {
  const total = rollupUsd(report.total);
  const first = [`thinking ${money(report.total.usdThinking)}`];
  if (report.subagentUsd > 0) {
    first.push(`subagents ${money(report.subagentUsd)} (${pctOf(report.subagentUsd, total)})`);
  }
  if (report.total.webSearches > 0) {
    first.push(
      `${String(report.total.webSearches)} web searches ${money(report.total.webSearches * WEB_SEARCH_USD)}`,
    );
  }
  if (report.activity.turnMs > 0) first.push(`${hoursMinutes(report.activity.turnMs)} working`);
  const limited = report.activity.apiErrors["429 usage_limit_reached"] ?? 0;
  const otherErrors =
    Object.values(report.activity.apiErrors).reduce((sum, count) => sum + count, 0) - limited;
  if (limited > 0) first.push(`${String(limited)} requests hit the usage limit`);
  if (otherErrors > 0)
    first.push(`${String(otherErrors)} API error${otherErrors === 1 ? "" : "s"}`);
  const lines = [first.join(" · ")];
  const top = Object.entries(report.activity.attributedUsd)
    .filter(([, usd]) => usd >= 0.01)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3);
  if (top.length > 0) {
    lines.push(
      `skills & MCP: ${top.map(([name, usd]) => `${name.replace(/^(skill|mcp):/, "")} ${money(usd)}`).join(" · ")}`,
    );
  }
  return lines;
}

/** The report: total and trend, $ per day, what the $ paid for, then one bar per row of `--by`. */
export function formatReport(report: Report, options: FormatOptions = { color: false }): string {
  const { color } = options;
  const total = rollupUsd(report.total);
  const days = Math.max(1, report.daily.length);
  const title = `${report.range.label.toUpperCase()}  ${shortDay(report.range.from)} → ${shortDay(report.daily.at(-1)?.[0] ?? report.range.to)}`;
  if (report.rows.length === 0) return `No usage in ${report.range.label}.`;
  const out = [
    `${BOLD(title, color)}   ${BOLD(money(total), color)}${report.total.unpricedTurns > 0 ? "+" : ""}   ≈ ${money(total / days)}/day   ${versus(report, color)}`.trimEnd(),
  ];
  if (report.daily.length > 1) {
    out.push(
      `${paint("110;150;230", sparkline(report.daily.map(([, usd]) => usd)), color)}  ${DIM("$ per day", color)}`,
    );
  }
  const split = report.total.usdNewWork + report.total.usdCarry + report.total.usdRewrite;
  if (split > 0) {
    const legend = PARTS.map((part) => ({ part, usd: part.usd(report.total) }))
      .filter(({ usd }) => usd / total >= 0.005)
      .map(
        ({ part, usd }) =>
          `${paint(part.rgb, color ? "■" : part.glyph, color)} ${part.label} ${pctOf(usd, total)}`,
      );
    out.push(
      "",
      BOLD("WHAT THE $ PAID FOR", color),
      `  ${stacked(segments(report.total), SPLIT_CELLS, color)}`,
      `  ${legend.join("   ")}`,
    );
  }
  const sessions = report.by === "session";
  // A by-day report reads left to right in time; every other view ranks by $.
  const rows =
    report.by === "day"
      ? [...report.rows].sort((a, b) => a.label.localeCompare(b.label))
      : report.rows.slice(0, 15);
  const label = (text: string): string =>
    report.by === "model" ? text.replace(/^claude-/, "") : text;
  const width = Math.min(34, Math.max(...rows.map((row) => label(row.label).length)));
  const largest = Math.max(0, ...rows.map((row) => rollupUsd(row.rollup)));
  const amounts = rows.map((row) => money(rollupUsd(row.rollup)));
  const amountWidth = Math.max(...amounts.map((text) => text.length));
  out.push("", BOLD(`BY ${report.by.toUpperCase()}`, color));
  rows.forEach((row, index) => {
    const usd = rollupUsd(row.rollup);
    const cells = largest > 0 && usd > 0 ? Math.max(1, Math.round((usd / largest) * ROW_CELLS)) : 0;
    const bar =
      cells === 0
        ? ""
        : sessions
          ? paint("110;150;230", "█".repeat(cells), color)
          : stacked(segments(row.rollup), cells, color);
    const extra = sessions
      ? DIM(
          [
            row.weekPct == null ? "" : `≈${row.weekPct.toFixed(1)}% of 7d limit`,
            row.usdPer100Lines == null ? "" : `${money(row.usdPer100Lines)}/100 lines`,
          ]
            .filter(Boolean)
            .join(" · "),
          color,
        )
      : "";
    out.push(
      `  ${label(row.label).slice(0, width).padEnd(width)}  ${bar}${" ".repeat(ROW_CELLS - cells)}  ${(amounts[index] as string).padStart(amountWidth)}  ${pctOf(usd, total).padStart(4)}${extra ? `  ${extra}` : ""}`,
    );
  });
  if (report.rows.length > rows.length) {
    out.push(DIM(`  … ${String(report.rows.length - rows.length)} more (--json for all)`, color));
  }
  out.push("", ...extraLines(report).map((line) => DIM(line, color)));
  const warnings: Array<string> = [];
  if (report.total.unpricedTurns > 0) {
    warnings.push(
      `${String(report.total.unpricedTurns)} turns on models with no price: totals are a floor.`,
    );
  }
  if (report.unattributedUsd > 0) {
    warnings.push(
      `${money(report.unattributedUsd)} more in sessions no account claimed (report --account unattributed).`,
    );
  }
  const claudeCode = claudeCodeNote(report.claudeCode);
  if (claudeCode !== null) warnings.push(claudeCode);
  warnings.push(...report.gaps);
  out.push(...warnings.map((line) => DIM(line, color)));
  out.push(DIM("API-equivalent estimate, not a bill · what to change: cc-spend insights", color));
  return out.join("\n");
}

/** `Claude Code counted $41.20 for 12 sessions: $3.10 (8%) more than the transcripts show …`. */
function claudeCodeNote(totals: ClaudeCodeTotals | null): string | null {
  if (totals === null) return null;
  const extra = totals.claudeCodeUsd - totals.transcriptUsd;
  if (extra < 0.01) return null;
  const pct = totals.transcriptUsd > 0 ? Math.round((extra / totals.transcriptUsd) * 100) : 100;
  return `Claude Code counted ${money(totals.claudeCodeUsd)} for ${String(totals.sessions)} of these sessions: ${money(extra)} (${String(pct)}%) more than the transcripts show, in requests they do not record.`;
}

export interface ReportArgs {
  readonly period: string;
  readonly by: Dimension;
  readonly json: boolean;
  readonly account: string | null;
  readonly session: string | null; // id or id prefix: one session's burn-up instead of the table
}

/** `report [period] [--by <dim>] [--json] [--account <key>] [--session <id>]` → args, or an error
 * message. */
export function parseReportArgs(argv: ReadonlyArray<string>): ReportArgs | string {
  let period = "week";
  let by: Dimension = "model";
  let json = false;
  let account: string | null = null;
  let session: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--json") json = true;
    else if (arg === "--session") {
      session = argv[++i] ?? "";
      if (session === "") return "--session needs a session id (or its first characters)";
    } else if (arg === "--by") {
      const value = argv[++i] ?? "";
      if (!(DIMENSIONS as ReadonlyArray<string>).includes(value)) {
        return `--by needs one of: ${DIMENSIONS.join(", ")}`;
      }
      by = value as Dimension;
    } else if (arg === "--account") {
      account = argv[++i] ?? "";
      if (account === "") return "--account needs an account key";
    } else if ((PERIODS as ReadonlyArray<string>).includes(arg) || /^\d{4}-\d{2}$/.test(arg)) {
      period = arg;
    } else return `Unknown report argument: ${arg}`;
  }
  return { period, by, json, account, session };
}
