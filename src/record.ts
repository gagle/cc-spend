import { CACHE_READ_GOOD, REREAD_GOOD, RESEND_GOOD } from "./advisor.js";
import type { Finding } from "./feed.js";
import { ruleInfo } from "./rules.js";
import { MTOK_GOOD } from "./session-model.js";
import type { Habits } from "./transcript-parse.js";

/**
 * The record: back-to-back periods (7 local days by default) that start and end by themselves, each frozen
 * when it closes and compared with the 7 days before the first one (the baseline) and with the record before
 * it. Pure and Node-free; the files and the index live in `src/record-store.ts`.
 */

/** Length of a record in local days, unless `record --days` set another. */
export const RECORD_DAYS = 7;
/** The baseline: this many local days before record #1. */
export const BASELINE_DAYS = 7;
/** Closed records kept. # ponytail: a year of weekly records; older ones drop, the baseline stays. */
export const KEEP_RECORDS = 52;
/** Before this many days a live record's rates are still noise. */
export const SETTLE_DAYS = 3;
/** A rate change smaller than this is noise (`≈`): 3% relative for $, 2 points for a share. */
export const SAME_RELATIVE = 0.03;
export const SAME_POINTS = 0.02;
/** A rule's $ per week must move this much to be listed. */
export const MIN_MOVE_USD = 0.5;
/** Rules that are not waste you can cut: R6 is relative to your median, R8 has no $, R10 and R11 are the
 * re-reading and re-sending scores already. They count neither in "avoidable $" nor as a focus (R6, R8). */
const NOT_AVOIDABLE: ReadonlySet<string> = new Set(["R6", "R8", "R10", "R11"]);
const NOT_FOCUS: ReadonlySet<string> = new Set(["R6", "R8"]);

/** Everything the record measures over a range of local days. */
export interface Snapshot {
  readonly from: string; // YYYY-MM-DD, inclusive
  readonly to: string;
  readonly days: number; // days covered: the whole range, or the days so far for a live record
  readonly usd: number;
  readonly isFloor: boolean; // an unpriced model was seen: $ is a floor
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly growth: number; // context growth + output: new work
  readonly usdCarry: number;
  readonly usdRewrite: number;
  readonly subagentUsd: number;
  readonly turns: number;
  readonly sessions: number;
  readonly activeMs: number;
  readonly habits: Habits | null; // null: no day of the range was counted (indexed before habits existed)
  readonly models: Readonly<Record<string, number>>; // model → $
  readonly rules: Readonly<Record<string, number>>; // rule id → $ in the range
  readonly peak5h: number | null; // highest 5h / 7d % read in the range
  readonly peak7d: number | null;
}

export interface RecordEntry {
  readonly n: number;
  readonly from: string;
  readonly to: string;
  readonly focus: string | null; // rule id to work on, from the record (or baseline) before
  readonly focusShare: number | null; // that rule's share of $ where it was picked
  readonly snapshot?: Snapshot; // set when the record closed
}

/** accounts/<key>/records.json */
export interface RecordsFile {
  readonly days: number; // length of the next record
  readonly baseline: Snapshot | null; // null: no use in the days before record #1
  readonly current: RecordEntry | null;
  readonly closed: ReadonlyArray<RecordEntry>;
  readonly unseen: number | null; // a closed record `cc-spend record` has not shown yet
}

export function emptyRecords(): RecordsFile {
  return { days: RECORD_DAYS, baseline: null, current: null, closed: [], unseen: null };
}

// ── days ──

/** `day` + `n` local days. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d + n);
  const pad = (v: number): string => String(v).padStart(2, "0");
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local days `from..to` inclusive. */
export function daysBetween(from: string, to: string): number {
  const [a, b] = [from, to].map((day) => {
    const [y, m, d] = day.split("-").map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  }) as [number, number];
  return Math.round((b - a) / 86_400_000) + 1;
}

// ── metrics ──

export type Metric = "perMTok" | "avoidable" | "cacheReads" | "resend" | "reread";

export interface MetricInfo {
  readonly id: Metric;
  readonly label: string; // plain words: the screen never shows a term it does not explain
  readonly means: string; // what a bad value means, shown next to the fix
  readonly aim: string;
  readonly higherIsBetter: boolean;
  readonly share: boolean; // a 0-1 share (compared in points) or $ (compared relatively)
  readonly good: (value: number) => boolean;
}

const pct = (fraction: number): string => `${String(Math.round(fraction * 100))}%`;

export const METRICS: ReadonlyArray<MetricInfo> = [
  {
    id: "perMTok",
    label: "cost of new work",
    means: "$ per 1M tokens of new output and context: lower means less re-reading",
    aim: `< $${String(MTOK_GOOD)}`,
    higherIsBetter: false,
    share: false,
    good: (v) => v < MTOK_GOOD,
  },
  {
    id: "avoidable",
    label: "wasted $",
    means: "share of $ the fixes in cc-spend insights would save",
    aim: "< 10%",
    higherIsBetter: false,
    share: true,
    good: (v) => v < 0.1,
  },
  {
    id: "cacheReads",
    label: "cache hits",
    means: "share of context read from the cache at ~0.1x instead of sent again",
    aim: `≥ ${pct(CACHE_READ_GOOD)}`,
    higherIsBetter: true,
    share: true,
    good: (v) => v >= CACHE_READ_GOOD,
  },
  {
    id: "resend",
    label: "cache rebuilds",
    means: "share of $ paid to send context again after a break or a model switch",
    aim: `< ${pct(RESEND_GOOD)}`,
    higherIsBetter: false,
    share: true,
    good: (v) => v < RESEND_GOOD,
  },
  {
    id: "reread",
    label: "history re-reads",
    means: "share of $ spent re-reading the conversation, not doing new work",
    aim: `< ${pct(REREAD_GOOD)}`,
    higherIsBetter: false,
    share: true,
    good: (v) => v < REREAD_GOOD,
  },
];

/** $ of the rules that are waste you can cut, capped at the total (rules overlap). */
export function avoidableUsd(snapshot: Snapshot): number {
  const sum = Object.entries(snapshot.rules)
    .filter(([id]) => !NOT_AVOIDABLE.has(id))
    .reduce((total, [, usd]) => total + usd, 0);
  return Math.min(snapshot.usd, sum);
}

/** One habit's value; null when the snapshot has nothing to divide by. */
export function metricValue(snapshot: Snapshot, metric: Metric): number | null {
  const { usd } = snapshot;
  if (metric === "perMTok") {
    return snapshot.growth > 0 ? (usd / snapshot.growth) * 1_000_000 : null;
  }
  if (metric === "cacheReads") {
    const fed = snapshot.input + snapshot.cacheRead + snapshot.cacheWrite;
    return fed > 0 ? snapshot.cacheRead / fed : null;
  }
  if (usd <= 0) return null;
  if (metric === "avoidable") return avoidableUsd(snapshot) / usd;
  return (metric === "resend" ? snapshot.usdRewrite : snapshot.usdCarry) / usd;
}

export type Change = "better" | "worse" | "same";

/** `after` against `before` for a value where lower (or higher) is better; null when either is unknown. */
export function changeOf(
  before: number | null,
  after: number | null,
  higherIsBetter: boolean,
  share: boolean,
): Change | null {
  if (before === null || after === null) return null;
  const delta = after - before;
  const small = share
    ? Math.abs(delta) < SAME_POINTS
    : before === 0 || Math.abs(delta / before) < SAME_RELATIVE;
  if (small) return "same";
  return delta > 0 === higherIsBetter ? "better" : "worse";
}

export function metricChange(
  before: Snapshot | null | undefined,
  after: Snapshot | null | undefined,
  metric: MetricInfo,
): Change | null {
  if (!before || !after) return null;
  return changeOf(
    metricValue(before, metric.id),
    metricValue(after, metric.id),
    metric.higherIsBetter,
    metric.share,
  );
}

/** How many of the habits got better from `before` to `after`, out of those both can measure. */
export function habitsBetter(
  before: Snapshot,
  after: Snapshot,
): { readonly better: number; readonly of: number } {
  const changes = METRICS.map((metric) => metricChange(before, after, metric)).filter(
    (change) => change !== null,
  );
  return { better: changes.filter((change) => change === "better").length, of: changes.length };
}

/** $ per week the new $/MTok saves (positive) or costs (negative) on the new work done at it. */
export function savedPerWeek(before: Snapshot, after: Snapshot): number | null {
  const was = metricValue(before, "perMTok");
  const now = metricValue(after, "perMTok");
  if (was === null || now === null || after.days <= 0) return null;
  return (((was - now) * after.growth) / 1_000_000) * (7 / after.days);
}

/** A rule's $ per 7 days. */
function weekly(snapshot: Snapshot, id: string): number {
  return ((snapshot.rules[id] ?? 0) * 7) / Math.max(1, snapshot.days);
}

export interface RuleMove {
  readonly id: string;
  readonly title: string;
  readonly usdPerWeek: number; // after − before; negative = less waste
}

/** Rules whose $ per week moved at least MIN_MOVE_USD: the two that dropped most, the two that grew most. */
export function ruleMoves(
  before: Snapshot,
  after: Snapshot,
): { readonly better: ReadonlyArray<RuleMove>; readonly worse: ReadonlyArray<RuleMove> } {
  const ids = [...new Set([...Object.keys(before.rules), ...Object.keys(after.rules)])];
  const moves = ids
    .map((id) => ({
      id,
      title: ruleInfo(id)?.title ?? id,
      usdPerWeek: weekly(after, id) - weekly(before, id),
    }))
    .filter((move) => Math.abs(move.usdPerWeek) >= MIN_MOVE_USD);
  return {
    better: moves
      .filter((move) => move.usdPerWeek < 0)
      .sort((a, b) => a.usdPerWeek - b.usdPerWeek)
      .slice(0, 2),
    worse: moves
      .filter((move) => move.usdPerWeek > 0)
      .sort((a, b) => b.usdPerWeek - a.usdPerWeek)
      .slice(0, 2),
  };
}

/** The rule with the most $ that is a habit to change, and its share of $. */
export function pickFocus(snapshot: Snapshot | null | undefined): {
  readonly focus: string | null;
  readonly focusShare: number | null;
} {
  if (!snapshot || snapshot.usd <= 0) return { focus: null, focusShare: null };
  const top = Object.entries(snapshot.rules)
    .filter(([id]) => !NOT_FOCUS.has(id))
    .sort((a, b) => b[1] - a[1])[0];
  return top
    ? { focus: top[0], focusShare: top[1] / snapshot.usd }
    : { focus: null, focusShare: null };
}

/** Rules whose fix moves one habit: their focus is judged by that habit, the number the table shows. */
const RULE_HABIT: Readonly<Record<string, Metric>> = {
  R4: "cacheReads",
  R10: "reread",
  R11: "resend",
};

/** Where the focus stood when it was picked and where it is now: its habit when it has one (and `source`, the
 * snapshot it was picked from, is known), else its share of $. */
export function focusProgress(
  entry: RecordEntry,
  snapshot: Snapshot,
  source: Snapshot | null | undefined,
): {
  readonly metric: MetricInfo | null;
  readonly was: number | null;
  readonly now: number | null;
  readonly change: Change | null;
} | null {
  if (entry.focus === null) return null;
  const id = RULE_HABIT[entry.focus];
  const metric = METRICS.find((m) => m.id === id) ?? null;
  if (metric !== null && source) {
    const was = metricValue(source, metric.id);
    const now = metricValue(snapshot, metric.id);
    return { metric, was, now, change: changeOf(was, now, metric.higherIsBetter, metric.share) };
  }
  const now = snapshot.usd > 0 ? (snapshot.rules[entry.focus] ?? 0) / snapshot.usd : null;
  return {
    metric: null,
    was: entry.focusShare,
    now,
    change: changeOf(entry.focusShare, now, false, true),
  };
}

/** The focus's verdict: its habit (or share of $) now against where it was picked. */
export function focusChange(
  entry: RecordEntry,
  snapshot: Snapshot,
  source?: Snapshot | null,
): Change | null {
  return focusProgress(entry, snapshot, source)?.change ?? null;
}

// ── lifecycle ──

export type SnapshotOf = (from: string, to: string) => Snapshot;

/** The entry that starts on `from`, with its focus picked from `source`. */
function startEntry(
  n: number,
  from: string,
  days: number,
  source: Snapshot | null | undefined,
): RecordEntry {
  return { n, from, to: addDays(from, days - 1), ...pickFocus(source) };
}

/**
 * Moves the records to `today`: starts record #1 (and freezes the baseline) when there is none, closes the
 * current record once `today` is past its last day and starts the next one the day after. A closed record with
 * no turns is not kept; the next one then starts today, with the same number and focus.
 */
export function advance(file: RecordsFile, today: string, snapshotOf: SnapshotOf): RecordsFile {
  if (file.current === null) {
    const taken = snapshotOf(addDays(today, -BASELINE_DAYS), addDays(today, -1));
    const baseline = taken.turns > 0 ? taken : null;
    return { ...file, baseline, current: startEntry(1, today, file.days, baseline) };
  }
  let next = file;
  let current = file.current;
  while (today > current.to) {
    const snapshot = snapshotOf(current.from, current.to);
    current =
      snapshot.turns === 0
        ? { ...current, from: today, to: addDays(today, next.days - 1) }
        : startEntry(current.n + 1, addDays(current.to, 1), next.days, snapshot);
    next =
      snapshot.turns === 0
        ? { ...next, current }
        : {
            ...next,
            closed: [...next.closed, { ...(next.current as RecordEntry), snapshot }].slice(
              -KEEP_RECORDS,
            ),
            unseen: (next.current as RecordEntry).n,
            current,
          };
  }
  return next;
}

/** What this week's findings are compared with: the last closed record, else the start. */
export function trendReference(file: RecordsFile): Snapshot | null {
  return file.closed.at(-1)?.snapshot ?? file.baseline;
}

/** The name of `trendReference` on screen. */
export function trendName(file: RecordsFile): string {
  return file.closed.length > 0 ? "last week" : "your start";
}

/**
 * Each finding with its $/week against `reference` (`trendUsdPerWeek`), re-ranked so a habit that is getting
 * worse comes before one that is merely large: score = $/week + its rise. Snoozed findings stay last and a
 * finding with no $ (R8) first, as `coach` ranks them.
 */
export function withTrends(
  advice: ReadonlyArray<Finding>,
  reference: Snapshot | null,
): ReadonlyArray<Finding> {
  const perWeek = (finding: Finding): number =>
    finding.usd === null ? 0 : finding.window === "week" ? finding.usd : (finding.usd * 7) / 30;
  const trended = advice.map((finding) => ({
    ...finding,
    trendUsdPerWeek:
      reference === null || finding.usd === null
        ? null
        : perWeek(finding) - weekly(reference, finding.id),
  }));
  const rank = (finding: Finding): [number, number, number] => [
    finding.snoozedUntil === null ? 0 : 1,
    finding.usd === null ? 0 : 1,
    -(perWeek(finding) + Math.max(0, finding.trendUsdPerWeek ?? 0)),
  ];
  return trended
    .map((finding, index) => ({ finding, index, key: rank(finding) }))
    .sort(
      (a, b) =>
        a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2] || a.index - b.index,
    )
    .map(({ finding }) => finding);
}

/** Days of `entry` up to `today`, at least 1, at most its length. */
export function daysSoFar(entry: RecordEntry, today: string): number {
  const length = daysBetween(entry.from, entry.to);
  return Math.max(1, Math.min(length, daysBetween(entry.from, today)));
}

/** The statusline's note for a closed record nobody has looked at yet; null when there is none. */
export function recordNotice(file: RecordsFile): string | null {
  if (file.unseen === null) return null;
  const index = file.closed.findIndex((entry) => entry.n === file.unseen);
  const entry = file.closed[index];
  if (!entry?.snapshot) return null;
  const against = file.baseline ?? file.closed[index - 1]?.snapshot;
  const score = against ? habitsBetter(against, entry.snapshot) : null;
  const habits =
    score && score.of > 0 ? `: ${String(score.better)}/${String(score.of)} habits better` : "";
  const change = focusChange(
    entry,
    entry.snapshot,
    file.closed[index - 1]?.snapshot ?? file.baseline,
  );
  const focus = change === "better" ? " · focus ✔" : change === "worse" ? " · focus ✖" : "";
  return `record #${String(entry.n)} done${habits}${focus} · cc-spend record`;
}

// ── screen ──

export interface RecordView {
  readonly file: RecordsFile;
  readonly live: Snapshot | null; // the current record so far
  readonly today: string;
  readonly closedNow: RecordEntry | null; // the record that closed since the last look
}

type Paint = (code: string, text: string) => string;

function painter(color: boolean): Paint {
  return (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
}

const BOLD = "1";
const DIM = "2";
// Truecolor, the statusline's own red (`❄ cold`) and a matching green.
const GREEN = "1;38;2;80;220;120";
const RED = "1;38;2;248;105;107";
const ORANGE = "38;5;208";

const money = (usd: number): string =>
  usd >= 10 ? `$${usd.toFixed(0)}` : `$${usd.toFixed(2).replace(/\.00$/, "")}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Nov 26" */
export function shortDay(day: string): string {
  return `${MONTHS[Number(day.slice(5, 7)) - 1] as string} ${String(Number(day.slice(8, 10)))}`;
}

function valueText(metric: MetricInfo, value: number | null): string {
  if (value === null) return "—";
  return metric.share ? pct(value) : `$${value.toFixed(0)}`;
}

/** `27%` for $, `11pt` for a share: how far `after` moved from `before`, unsigned (the arrow carries the sign). */
function deltaText(metric: MetricInfo, before: number, after: number): string {
  if (metric.share) return `${String(Math.abs(Math.round((after - before) * 100)))}pt`;
  // `changeOf` calls a move from $0 "same", so `before` is never 0 here.
  return `${String(Math.abs(Math.round(((after - before) / before) * 100)))}%`;
}

/** A value against its aim: green when met, red when not, dim when unknown. */
function aimPaint(metric: MetricInfo, value: number | null, text: string, paint: Paint): string {
  if (value === null) return paint(DIM, text);
  return paint(metric.good(value) ? GREEN : RED, text);
}

function mark(change: Change, paint: Paint): string {
  if (change === "better") return paint(GREEN, "✔");
  return change === "worse" ? paint(RED, "✖") : paint(DIM, "≈");
}

/** Pads to `width` columns, counting what is printed (ANSI codes take no column). */
function pad(text: string, width: number, left = false): string {
  // eslint-disable-next-line no-control-regex
  const shown = text.replace(/\x1b\[[0-9;]*m/g, "").length;
  const space = " ".repeat(Math.max(0, width - shown));
  return left ? space + text : text + space;
}

function bar(fraction: number, cells: number): string {
  const full = Math.round(Math.max(0, Math.min(1, fraction)) * cells);
  return `▕${"█".repeat(full)}${"░".repeat(cells - full)}▏`;
}

/** `▼ 27% better` / `▲ 3pt worse` / `≈ same`, colored; the arrow is the value's direction, the word the verdict. */
function changeCell(
  metric: MetricInfo,
  before: number | null,
  after: number | null,
  paint: Paint,
): string {
  const change =
    before === null || after === null
      ? null
      : changeOf(before, after, metric.higherIsBetter, metric.share);
  if (change === null || before === null || after === null) return "";
  if (change === "same") return paint(DIM, "≈ same");
  const text = `${after > before ? "▲" : "▼"} ${deltaText(metric, before, after)} ${change}`;
  return paint(change === "better" ? GREEN : RED, text);
}

/** The values a habit took over the baseline, the closed records (newest 5) and the live one, oldest first. */
function history(file: RecordsFile, live: Snapshot, metric: Metric): ReadonlyArray<number | null> {
  const snapshots = [
    ...(file.baseline ? [file.baseline] : []),
    ...file.closed.slice(-5).flatMap((entry) => (entry.snapshot ? [entry.snapshot] : [])),
    live,
  ];
  return snapshots.map((snapshot) => metricValue(snapshot, metric));
}

/** A habit's trend on a fixed scale (0-100% for a share, 0 to the largest $ for $), so a flat habit draws flat. */
function trendline(metric: MetricInfo, values: ReadonlyArray<number | null>): string {
  const high = metric.share ? 1 : Math.max(Number.EPSILON, ...values.map((value) => value ?? 0));
  return values
    .map((value) =>
      value === null
        ? "·"
        : (SPARK[Math.round((Math.min(value, high) / high) * (SPARK.length - 1))] as string),
    )
    .join("");
}

/** Habits that meet their aim, out of those the snapshot can measure. */
export function onTarget(snapshot: Snapshot): { readonly met: number; readonly of: number } {
  const values = METRICS.map(
    (metric) => [metric, metricValue(snapshot, metric.id)] as const,
  ).filter(([, value]) => value !== null);
  return {
    met: values.filter(([metric, value]) => metric.good(value as number)).length,
    of: values.length,
  };
}

function habitsTable(
  file: RecordsFile,
  ref: Snapshot | null,
  refName: string,
  now: Snapshot,
  paint: Paint,
  early: boolean,
): ReadonlyArray<string> {
  const head = [
    pad("HABIT", 19),
    pad("NOW", 5, true),
    pad("TARGET", 9, true),
    "   ",
    pad("TREND", 8),
    early || ref === null ? "" : `VS ${refName.toUpperCase()}`,
  ].join("");
  const rows = METRICS.map((metric) => {
    const value = metricValue(now, metric.id);
    const change =
      early || ref === null ? "" : changeCell(metric, metricValue(ref, metric.id), value, paint);
    return [
      pad(metric.label, 19),
      // Meeting the aim is a fact on any day; only the comparison waits for SETTLE_DAYS.
      pad(aimPaint(metric, value, valueText(metric, value), paint), 5, true),
      pad(paint(DIM, metric.aim), 9, true),
      "   ",
      pad(paint(DIM, trendline(metric, history(file, now, metric.id))), 8),
      change,
    ]
      .join("")
      .trimEnd();
  });
  return [paint(BOLD, head.trimEnd()), ...rows];
}

/** `●●●●○ 4 of 5 habits on target`, then the $ verdict against the start. */
function headline(
  file: RecordsFile,
  now: Snapshot,
  paint: Paint,
  early: boolean,
): ReadonlyArray<string> {
  const { met, of } = onTarget(now);
  const dots = paint(GREEN, "●".repeat(met)) + paint(RED, "○".repeat(of - met));
  const lines = [
    `${paint(BOLD, "HOW YOU'RE DOING")}  ${dots}  ${String(met)} of ${String(of)} habits on target`,
  ];
  const base = file.baseline;
  if (early) {
    lines.push(
      paint(
        DIM,
        `  Too early to compare: day ${String(now.days)}. Numbers settle after day ${String(SETTLE_DAYS)}.`,
      ),
    );
    return lines;
  }
  if (!base) {
    lines.push(paint(DIM, "  No start to compare with: no use in the 7 days before record #1."));
    return lines;
  }
  const was = metricValue(base, "perMTok");
  const is = metricValue(now, "perMTok");
  const saved = savedPerWeek(base, now);
  const parts: Array<string> = [];
  if (was !== null && is !== null && was > 0) {
    const relative = Math.round(((is - was) / was) * 100);
    parts.push(
      relative === 0
        ? "new work costs the same as at your start"
        : `new work costs ${paint(relative < 0 ? GREEN : RED, `${String(Math.abs(relative))}% ${relative < 0 ? "less" : "more"}`)} than at your start`,
    );
  }
  if (saved !== null && Math.abs(saved) >= MIN_MOVE_USD) {
    parts.push(
      saved > 0
        ? paint(GREEN, `~${money(saved)}/week saved`)
        : paint(RED, `~${money(-saved)}/week more`),
    );
  }
  if (parts.length > 0) lines.push(`  ${parts.join(" · ")}`);
  return lines;
}

/** For a habit off its aim, the rule whose fix moves it: the costliest matching one in the snapshot. */
function ruleFor(metric: Metric, now: Snapshot): string {
  const fixer = Object.entries(RULE_HABIT).find(([, habit]) => habit === metric);
  if (fixer) return fixer[0];
  const skip = metric === "avoidable" ? NOT_AVOIDABLE : NOT_FOCUS;
  const top = Object.entries(now.rules)
    .filter(([id]) => !skip.has(id))
    .sort((a, b) => b[1] - a[1])[0];
  return top?.[0] ?? "R10";
}

/** `✖ cache rebuilds 17%  → no long breaks mid-task · ~$12/week` per habit off its aim, with what it means. */
function fixLines(now: Snapshot, paint: Paint): ReadonlyArray<string> {
  const off = METRICS.flatMap((metric) => {
    const value = metricValue(now, metric.id);
    return value === null || metric.good(value) ? [] : [{ metric, value }];
  });
  if (off.length === 0) return [];
  return [
    paint(BOLD, "FIX NEXT"),
    ...off.flatMap(({ metric, value }) => {
      const id = ruleFor(metric.id, now);
      const info = ruleInfo(id);
      const usd = weekly(now, id);
      const worth = usd >= MIN_MOVE_USD ? paint(DIM, ` · ~${money(usd)}/week`) : "";
      return [
        `  ${paint(RED, "✖")} ${pad(`${metric.label} ${valueText(metric, value)}`, 24)}→ ${info?.action ?? id}${worth}`,
        paint(DIM, `      ${metric.means}`),
      ];
    }),
  ];
}

function focusLines(
  entry: RecordEntry,
  source: Snapshot | null,
  now: Snapshot,
  paint: Paint,
  early: boolean,
): ReadonlyArray<string> {
  const progress = focusProgress(entry, now, source);
  if (progress === null || entry.focus === null) return [];
  const info = ruleInfo(entry.focus);
  const change = early ? null : progress.change;
  const verdict =
    change === "better"
      ? paint(GREEN, "✔ better, keep going")
      : change === "worse"
        ? paint(RED, "✖ worse")
        : change === "same"
          ? paint(DIM, "≈ same")
          : "";
  const text = (value: number | null): string =>
    progress.metric ? valueText(progress.metric, value) : value === null ? "—" : pct(value);
  const what = progress.metric ? progress.metric.label : "share of $";
  const was = progress.was === null ? "" : `${text(progress.was)} → `;
  return [
    `${paint(ORANGE, "FOCUS THIS WEEK")}  ${info?.action ?? ""} ${paint(DIM, `(${entry.focus} ${info?.title ?? ""})`)}`,
    `  ${what} ${was}${text(progress.now)} now  ${verdict}`.trimEnd(),
  ];
}

function moveLines(
  before: Snapshot | null,
  refName: string,
  now: Snapshot,
  paint: Paint,
): ReadonlyArray<string> {
  if (!before) return [];
  const { better, worse } = ruleMoves(before, now);
  if (better.length === 0 && worse.length === 0) return [];
  const line = (move: RuleMove): string => {
    const down = move.usdPerWeek < 0;
    return paint(
      down ? GREEN : RED,
      `  ${down ? "▼" : "▲"} ${pad(move.title, 32)}${pad(`${down ? "−" : "+"}${money(Math.abs(move.usdPerWeek))}/week`, 14, true)}`,
    );
  };
  return [paint(BOLD, `CHANGED MOST vs ${refName}`), ...better.map(line), ...worse.map(line)];
}

function hours(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return `${String(Math.floor(minutes / 60))}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** How much you worked, never scored: two lines, the start's value in parentheses. */
function activityLines(base: Snapshot | null, now: Snapshot, paint: Paint): ReadonlyArray<string> {
  const floor = now.isFloor ? "≥ " : "";
  const then = (text: string | null): string =>
    base && text !== null ? paint(DIM, ` (start ${text})`) : "";
  const prompts = (s: Snapshot): number | null => (s.habits ? s.habits.prompt : null);
  const first = [`${floor}${money(now.usd)} so far${then(base ? money(base.usd) : null)}`];
  const nowPrompts = prompts(now);
  if (nowPrompts !== null) {
    const perDay = (s: Snapshot): string | null => {
      const p = prompts(s);
      return p === null ? null : String(Math.round(p / s.days));
    };
    const perPrompt = (s: Snapshot): string | null => {
      const p = prompts(s);
      return p ? money(s.usd / p) : null;
    };
    first.push(`${perDay(now) as string} prompts/day${then(base ? perDay(base) : null)}`);
    const each = perPrompt(now);
    if (each !== null) first.push(`${each}/prompt${then(base ? perPrompt(base) : null)}`);
  }
  const second = [
    `${hours(now.activeMs / now.days)} active/day`,
    `${String(now.sessions)} sessions`,
  ];
  if (now.habits) {
    const h = now.habits;
    second.push(
      `${String(h.clear)} /clear`,
      `${String(h.compact + h.autoCompact)} compacts`,
      `${String(h.model)} /model`,
      `${String(h.interrupt)} interrupt${h.interrupt === 1 ? "" : "s"}`,
    );
  }
  const top = Object.entries(now.models).sort((a, b) => b[1] - a[1])[0];
  if (top && now.usd > 0)
    second.push(`${top[0].replace(/^claude-/, "")} ${pct(top[1] / now.usd)} of $`);
  if (now.peak7d !== null) second.push(`7d limit peak ${String(Math.round(now.peak7d))}%`);
  return [
    paint(BOLD, "ACTIVITY") + paint(DIM, "  how much you worked, not scored"),
    `  ${first.join(" · ")}`,
    `  ${second.join(" · ")}`,
  ];
}

/** The block for a record that closed since the last look. */
function closedLines(
  file: RecordsFile,
  closed: RecordEntry,
  current: RecordEntry,
  paint: Paint,
): ReadonlyArray<string> {
  const snapshot = closed.snapshot as Snapshot;
  const { met, of } = onTarget(snapshot);
  const out = [
    `${paint(BOLD, `RECORD #${String(closed.n)} DONE`)}  ${shortDay(closed.from)} → ${shortDay(closed.to)}  ${String(met)} of ${String(of)} habits on target`,
  ];
  const before = file.closed[file.closed.indexOf(closed) - 1]?.snapshot ?? file.baseline;
  if (before) {
    const score = habitsBetter(before, snapshot);
    out.push(
      `  ${String(score.better)} of ${String(score.of)} habits better than ${file.closed.indexOf(closed) > 0 ? "the week before" : "your start"}`,
    );
  }
  const change = focusChange(closed, snapshot, before);
  if (closed.focus !== null && change !== null) {
    const word =
      change === "better"
        ? paint(GREEN, "✔ kept")
        : change === "worse"
          ? paint(RED, "✖ slipped")
          : paint(DIM, "≈ no change");
    out.push(`  focus ${ruleInfo(closed.focus)?.action ?? closed.focus}: ${word}`);
  }
  out.push("", paint(DIM, `Record #${String(current.n)} started ${shortDay(current.from)}.`), "");
  return out;
}

/** The `cc-spend record` screen: how you are doing, habit by habit, against last week and your start. */
export function formatRecord(view: RecordView, color: boolean): string {
  const paint = painter(color);
  const { file, live, today } = view;
  const current = file.current;
  if (current === null || live === null) {
    return "No record yet. The first one starts with the next background refresh (open Claude Code).";
  }
  const out: Array<string> = [];
  if (view.closedNow?.snapshot) out.push(...closedLines(file, view.closedNow, current, paint));
  const length = daysBetween(current.from, current.to);
  const soFar = daysSoFar(current, today);
  const early = soFar < SETTLE_DAYS;
  out.push(
    `${paint(BOLD, `RECORD #${String(current.n)}`)}  ${shortDay(current.from)} → ${shortDay(current.to)}  ${bar(soFar / length, 20)} day ${String(soFar)} of ${String(length)}`,
    "",
    ...headline(file, live, paint, early),
  );
  const prev = file.closed.at(-1)?.snapshot ?? null;
  const ref = prev ?? file.baseline;
  const refName = prev ? "last week" : "your start";
  out.push("", ...habitsTable(file, ref, refName, live, paint, early));
  const fixes = fixLines(live, paint);
  if (fixes.length > 0) out.push("", ...fixes);
  const focus = focusLines(current, ref, live, paint, early);
  if (focus.length > 0) out.push("", ...focus);
  const moves = early ? [] : moveLines(ref, refName, live, paint);
  if (moves.length > 0) out.push("", ...moves);
  out.push("", ...activityLines(file.baseline, live, paint));
  out.push(
    "",
    paint(
      DIM,
      "API-equivalent estimate, not a bill · every week: cc-spend record --all · fixes: cc-spend insights",
    ),
  );
  return out.join("\n");
}

const SPARK = "▁▂▃▄▅▆▇█";

/** `cc-spend record --all`: the baseline, every closed record and the live one, one row each. */
export function formatAll(view: RecordView, color: boolean): string {
  const paint = painter(color);
  const { file, live, today } = view;
  type Row = {
    readonly label: string;
    readonly snapshot: Snapshot;
    readonly entry: RecordEntry | null;
    readonly live: boolean;
  };
  const rows: Array<Row> = [
    ...(file.baseline ? [{ label: "b", snapshot: file.baseline, entry: null, live: false }] : []),
    ...file.closed.flatMap((entry) =>
      entry.snapshot
        ? [{ label: String(entry.n), snapshot: entry.snapshot, entry, live: false }]
        : [],
    ),
    ...(file.current && live
      ? [{ label: String(file.current.n), snapshot: live, entry: file.current, live: true }]
      : []),
  ];
  if (rows.length === 0)
    return "No record yet. The first one starts with the next background refresh (open Claude Code).";
  const shown = METRICS.filter((metric) => metric.id !== "reread");
  const head = [
    pad(" #", 4),
    pad("period", 18),
    ...shown.map((metric) =>
      pad(
        {
          perMTok: "cost/M",
          avoidable: "wasted",
          cacheReads: "hits",
          resend: "rebuilt",
          reread: "re-read",
        }[metric.id],
        8,
        true,
      ),
    ),
    pad("$ total", 10, true),
    pad("focus", 7, true),
    "  result",
  ].join("");
  const lines = rows.map((row, index) => {
    const period = `${shortDay(row.snapshot.from)} → ${row.live ? "now" : shortDay(row.snapshot.to)}`;
    const early = row.live && row.snapshot.days < SETTLE_DAYS;
    const change =
      row.entry && !early ? focusChange(row.entry, row.snapshot, rows[index - 1]?.snapshot) : null;
    const result =
      row.entry?.focus == null || change === null
        ? ""
        : `${mark(change, paint)}${row.live ? paint(DIM, " so far") : ""}`;
    return [
      pad(` ${row.label}`, 4),
      pad(period, 18),
      ...shown.map((metric) => {
        const value = metricValue(row.snapshot, metric.id);
        return pad(aimPaint(metric, value, valueText(metric, value), paint), 8, true);
      }),
      pad(`${money(row.snapshot.usd)}${row.live ? "…" : ""}`, 10, true),
      pad(row.entry?.focus ?? "—", 7, true),
      `  ${result}`,
    ].join("");
  });
  const trend = [
    pad("", 4),
    pad("trend", 18),
    ...shown.map((metric) =>
      pad(
        trendline(
          metric,
          rows.map((row) => metricValue(row.snapshot, metric.id)),
        ),
        8,
        true,
      ),
    ),
  ].join("");
  const days = file.current ? daysSoFar(file.current, today) : 0;
  return [
    paint(BOLD, "RECORDS") + paint(DIM, "  b = your start, the 7 days before record #1"),
    "",
    paint(BOLD, head),
    ...lines,
    paint(DIM, trend),
    "",
    paint(DIM, `Next record: ${String(file.days)} days. The live one is on day ${String(days)}.`),
  ].join("\n");
}

/** `--json`: every snapshot with its habit values. */
export function recordJson(view: RecordView): unknown {
  const withValues = (snapshot: Snapshot | null | undefined): unknown =>
    snapshot
      ? {
          ...snapshot,
          values: Object.fromEntries(
            METRICS.map((metric) => [metric.id, metricValue(snapshot, metric.id)]),
          ),
        }
      : null;
  return {
    days: view.file.days,
    baseline: withValues(view.file.baseline),
    closed: view.file.closed.map((entry) => ({ ...entry, snapshot: withValues(entry.snapshot) })),
    current: view.file.current ? { ...view.file.current, snapshot: withValues(view.live) } : null,
  };
}
