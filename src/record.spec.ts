import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Finding } from "./feed.js";
import {
  addDays,
  advance,
  avoidableUsd,
  changeOf,
  daysBetween,
  daysSoFar,
  emptyRecords,
  focusChange,
  focusProgress,
  formatAll,
  formatRecord,
  habitsBetter,
  metricChange,
  METRICS,
  metricValue,
  onTarget,
  pickFocus,
  type RecordEntry,
  recordJson,
  recordNotice,
  type RecordsFile,
  type RecordView,
  ruleMoves,
  savedPerWeek,
  shortDay,
  type Snapshot,
  trendName,
  trendReference,
  withTrends,
} from "./record.js";

function snap(fields: Partial<Snapshot> = {}): Snapshot {
  return {
    from: "2026-11-05",
    to: "2026-11-11",
    days: 7,
    usd: 100,
    isFloor: false,
    input: 10,
    output: 0,
    cacheRead: 80,
    cacheWrite: 10,
    growth: 2_000_000, // $50/MTok
    usdCarry: 50,
    usdRewrite: 20,
    subagentUsd: 0,
    turns: 10,
    sessions: 3,
    activeMs: 7 * 3_600_000,
    habits: { prompt: 70, interrupt: 1, clear: 2, model: 3, compact: 4, autoCompact: 5 },
    models: { "claude-opus-5-5": 90, "claude-sonnet-5-5": 10 },
    rules: { R4: 20, R5: 10, R6: 30, R10: 50 },
    peak5h: 40,
    peak7d: 60,
    ...fields,
  };
}

const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, ""); // eslint-disable-line no-control-regex

beforeEach(() => {
  vi.stubEnv("TZ", "UTC");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("days", () => {
  it.each(["UTC", "America/New_York", "Pacific/Auckland", "Asia/Kolkata"])(
    "addDays, daysBetween and shortDay are local-day math in %s",
    (zone) => {
      vi.stubEnv("TZ", zone);
      expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
      expect(addDays("2026-03-08", 1)).toBe("2026-03-09"); // US DST starts
      expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
      expect(daysBetween("2026-11-05", "2026-11-11")).toBe(7);
      expect(daysBetween("2026-03-07", "2026-03-09")).toBe(3);
      expect(shortDay("2026-11-05")).toBe("Nov 5");
    },
  );

  it("daysSoFar is clamped to 1..length", () => {
    const entry: RecordEntry = {
      n: 1,
      from: "2026-11-12",
      to: "2026-11-18",
      focus: null,
      focusShare: null,
    };
    expect(daysSoFar(entry, "2026-11-12")).toBe(1);
    expect(daysSoFar(entry, "2026-11-14")).toBe(3);
    expect(daysSoFar(entry, "2026-12-01")).toBe(7);
    expect(daysSoFar(entry, "2026-11-01")).toBe(1);
  });
});

describe("metrics", () => {
  it("values, with null when there is nothing to divide by", () => {
    const s = snap();
    expect(metricValue(s, "perMTok")).toBe(50);
    expect(metricValue(s, "cacheReads")).toBe(0.8);
    expect(metricValue(s, "resend")).toBe(0.2);
    expect(metricValue(s, "reread")).toBe(0.5);
    expect(metricValue(s, "avoidable")).toBe(0.3); // R4 + R5; R6 and R10 are not waste you can cut
    const empty = snap({ usd: 0, growth: 0, input: 0, cacheRead: 0, cacheWrite: 0 });
    for (const metric of METRICS) expect(metricValue(empty, metric.id)).toBeNull();
    expect(avoidableUsd(snap({ usd: 5, rules: { R4: 20 } }))).toBe(5); // capped: rules overlap
  });

  it("aims match the advisor", () => {
    expect(METRICS.map((m) => [m.id, m.aim, m.good(m.share ? 0.05 : 20)])).toEqual([
      ["perMTok", "< $33", true],
      ["avoidable", "< 10%", true],
      ["cacheReads", "≥ 90%", false],
      ["resend", "< 10%", true],
      ["reread", "< 54%", true],
    ]);
    expect(METRICS.map((m) => m.good(m.share ? 0.95 : 90))).toEqual([
      false,
      false,
      true,
      false,
      false,
    ]);
  });

  it("changeOf: 3% relative for $, 2 points for a share; direction; unknown", () => {
    expect(changeOf(50, 40, false, false)).toBe("better");
    expect(changeOf(50, 60, false, false)).toBe("worse");
    expect(changeOf(50, 51, false, false)).toBe("same");
    expect(changeOf(0, 5, false, false)).toBe("same");
    expect(changeOf(0.8, 0.9, true, true)).toBe("better");
    expect(changeOf(0.8, 0.81, true, true)).toBe("same");
    expect(changeOf(0.3, 0.2, false, true)).toBe("better");
    expect(changeOf(null, 1, false, true)).toBeNull();
    expect(changeOf(1, null, false, true)).toBeNull();
    const metric = METRICS[0] as (typeof METRICS)[number];
    expect(metricChange(null, snap(), metric)).toBeNull();
    expect(metricChange(snap(), undefined, metric)).toBeNull();
  });

  it("habitsBetter counts what both can measure", () => {
    const before = snap();
    const after = snap({ growth: 4_000_000, cacheRead: 90, cacheWrite: 0, usdRewrite: 21 });
    expect(habitsBetter(before, after)).toEqual({ better: 2, of: 5 });
    expect(habitsBetter(before, snap({ usd: 0, growth: 0 }))).toEqual({ better: 0, of: 1 });
  });

  it("savedPerWeek: the $/MTok change on the new work, per 7 days", () => {
    const after = snap({ days: 3.5, usd: 25, growth: 1_000_000 }); // $25/MTok
    expect(savedPerWeek(snap(), after)).toBe(50); // ($50 − $25) × 1 MTok × 7/3.5
    expect(savedPerWeek(snap(), snap({ growth: 0 }))).toBeNull();
    expect(savedPerWeek(snap(), snap({ days: 0 }))).toBeNull();
  });

  it("ruleMoves: $ per week, at least $0.50, two each way", () => {
    const before = snap({ rules: { R1: 10, R2: 10, R3: 10, R4: 1, R9: 0.2 } });
    const after = snap({ days: 3.5, rules: { R1: 1, R2: 2, R3: 3, R5: 4, R12: 1, X1: 9 } });
    const moves = ruleMoves(before, after);
    expect(moves.better.map((m) => [m.id, m.usdPerWeek])).toEqual([
      ["R1", -8],
      ["R2", -6],
    ]);
    expect(moves.worse.map((m) => [m.id, m.title, m.usdPerWeek])).toEqual([
      ["X1", "X1", 18],
      ["R5", "Deep context", 8],
    ]);
    expect(ruleMoves(snap({ days: 0, rules: {} }), snap({ days: 0, rules: { R1: 0.05 } }))).toEqual(
      {
        better: [],
        worse: [],
      },
    );
  });

  it("pickFocus: the top rule but R6/R8, with its share; none without $", () => {
    expect(pickFocus(snap())).toEqual({ focus: "R10", focusShare: 0.5 });
    expect(pickFocus(snap({ rules: { R6: 9, R8: 0 } }))).toEqual({ focus: null, focusShare: null });
    expect(pickFocus(snap({ usd: 0 }))).toEqual({ focus: null, focusShare: null });
    expect(pickFocus(null)).toEqual({ focus: null, focusShare: null });
  });

  it("focusChange: the focus share now against where it was picked", () => {
    const entry: RecordEntry = { n: 1, from: "a", to: "b", focus: "R4", focusShare: 0.3 };
    expect(focusChange(entry, snap())).toBe("better"); // 20% now
    expect(focusChange(entry, snap({ rules: {} }))).toBe("better");
    expect(focusChange({ ...entry, focusShare: 0.1 }, snap())).toBe("worse");
    expect(focusChange({ ...entry, focus: null }, snap())).toBeNull();
    expect(focusChange({ ...entry, focusShare: null }, snap())).toBeNull();
    expect(focusChange(entry, snap({ usd: 0 }))).toBeNull();
  });
});

describe("advance", () => {
  const busy = (from: string, to: string): Snapshot => snap({ from, to });

  it("starts record #1 with the 7 days before as baseline and its top rule as focus", () => {
    const calls: Array<string> = [];
    const file = advance(emptyRecords(), "2026-11-12", (from, to) => {
      calls.push(`${from}..${to}`);
      return busy(from, to);
    });
    expect(calls).toEqual(["2026-11-05..2026-11-11"]);
    expect(file.baseline?.from).toBe("2026-11-05");
    expect(file.current).toEqual({
      n: 1,
      from: "2026-11-12",
      to: "2026-11-18",
      focus: "R10",
      focusShare: 0.5,
    });
    expect(advance(file, "2026-11-18", () => busy("x", "y"))).toBe(file); // nothing to do: same object
  });

  it("no use before record #1: no baseline, no focus", () => {
    const file = advance({ ...emptyRecords(), days: 3 }, "2026-11-12", () => snap({ turns: 0 }));
    expect(file.baseline).toBeNull();
    expect(file.current).toMatchObject({ to: "2026-11-14", focus: null });
  });

  it("closes a record the day after its end, starts the next back to back, marks it unseen", () => {
    const one = advance(emptyRecords(), "2026-11-12", busy);
    const two = advance(one, "2026-11-19", busy);
    expect(two.closed).toHaveLength(1);
    expect(two.closed[0]).toMatchObject({
      n: 1,
      snapshot: { from: "2026-11-12", to: "2026-11-18" },
    });
    expect(two.unseen).toBe(1);
    expect(two.current).toMatchObject({ n: 2, from: "2026-11-19", to: "2026-11-25" });
  });

  it("an empty record is not kept: the next starts today with the same number; a long gap closes at most once", () => {
    const one = advance(emptyRecords(), "2026-11-12", busy);
    const later = advance(one, "2026-12-20", (from, to) =>
      from === "2026-11-12" ? busy(from, to) : snap({ turns: 0 }),
    );
    expect(later.closed.map((entry) => entry.n)).toEqual([1]);
    expect(later.current).toMatchObject({ n: 2, from: "2026-12-20", to: "2026-12-26" });
  });

  it("keeps the newest 52 closed records", () => {
    let file: RecordsFile = advance(emptyRecords(), "2026-01-01", busy);
    for (let week = 1; week <= 53; week++)
      file = advance(file, addDays("2026-01-01", week * 7), busy);
    expect(file.closed).toHaveLength(52);
    expect(file.closed[0]?.n).toBe(2);
  });
});

describe("recordNotice", () => {
  const closed = (n: number, s: Snapshot): RecordEntry => ({
    n,
    from: s.from,
    to: s.to,
    focus: null,
    focusShare: null,
    snapshot: s,
  });
  const better = snap({ growth: 4_000_000 });

  it("against the baseline, else the record before; none when seen or unknown", () => {
    const file: RecordsFile = {
      ...emptyRecords(),
      baseline: snap(),
      closed: [closed(1, better)],
      unseen: 1,
    };
    expect(recordNotice(file)).toBe("record #1 done: 1/5 habits better · cc-spend record");
    expect(recordNotice({ ...file, baseline: null })).toBe("record #1 done · cc-spend record");
    expect(
      recordNotice({
        ...file,
        baseline: null,
        closed: [closed(1, snap()), closed(2, better)],
        unseen: 2,
      }),
    ).toBe("record #2 done: 1/5 habits better · cc-spend record");
    expect(
      recordNotice({
        ...file,
        baseline: snap({ usd: 0, growth: 0, cacheRead: 0, input: 0, cacheWrite: 0 }),
      }),
    ).toBe("record #1 done · cc-spend record");
    expect(
      recordNotice({
        ...file,
        closed: [{ ...closed(1, snap({ usdRewrite: 5 })), focus: "R11", focusShare: 0.3 }],
      }),
    ).toBe("record #1 done: 1/5 habits better · focus ✔ · cc-spend record");
    expect(
      recordNotice({
        ...file,
        closed: [{ ...closed(1, snap({ usdRewrite: 50 })), focus: "R11", focusShare: 0.3 }],
      }),
    ).toBe("record #1 done: 0/5 habits better · focus ✖ · cc-spend record");
    expect(recordNotice({ ...file, unseen: null })).toBeNull();
    expect(recordNotice({ ...file, unseen: 9 })).toBeNull();
    expect(
      recordNotice({ ...file, closed: [{ ...closed(1, better), snapshot: undefined }] }),
    ).toBeNull();
  });
});

describe("formatRecord", () => {
  const current: RecordEntry = {
    n: 2,
    from: "2026-11-19",
    to: "2026-11-25",
    focus: "R4",
    focusShare: 0.3,
  };
  const prevEntry: RecordEntry = {
    n: 1,
    from: "2026-11-12",
    to: "2026-11-18",
    focus: "R10",
    focusShare: 0.5,
    snapshot: snap({ from: "2026-11-12", to: "2026-11-18", rules: { R10: 40, R1: 20 } }),
  };
  const live = snap({
    from: "2026-11-19",
    to: "2026-11-23",
    days: 5,
    usd: 50,
    growth: 2_000_000, // $25/MTok
    cacheRead: 95,
    cacheWrite: 0,
    input: 5,
    usdCarry: 20,
    usdRewrite: 2,
    rules: { R4: 5, R5: 20 },
    isFloor: true,
  });
  const view = (fields: Partial<RecordView> = {}): RecordView => ({
    file: { ...emptyRecords(), baseline: snap(), current, closed: [prevEntry] },
    live,
    today: "2026-11-23",
    closedNow: null,
    ...fields,
  });

  it("the live record: how you're doing, habits vs last week, what to fix, focus, changes, activity", () => {
    expect(strip(formatRecord(view(), false))).toMatchInlineSnapshot(`
      "RECORD #2  Nov 19 → Nov 25  ▕██████████████░░░░░░▏ day 5 of 7

      HOW YOU'RE DOING  ●●●●○  4 of 5 habits on target
        new work costs 50% less than at your start · ~$70/week saved

      HABIT                NOW   TARGET   TREND   VS LAST WEEK
      cost of new work     $25    < $33   ██▅     ▼ 50% better
      wasted $             50%    < 10%   ▃▂▅     ▲ 30pt worse
      cache hits           95%    ≥ 90%   ▇▇█     ▲ 15pt better
      cache rebuilds        4%    < 10%   ▂▂▁     ▼ 16pt better
      history re-reads     40%    < 54%   ▅▅▄     ▼ 10pt better

      FIX NEXT
        ✖ wasted $ 50%            → /compact earlier · ~$28/week
            share of $ the fixes in cc-spend insights would save

      FOCUS THIS WEEK  /compact before breaks (R4 Prompt cache re-paid)
        cache hits 80% → 95% now  ✔ better, keep going

      CHANGED MOST vs last week
        ▼ Most spend re-reads context          −$40/week
        ▼ Subagents on a premium model         −$20/week
        ▲ Deep context                         +$28/week
        ▲ Prompt cache re-paid                  +$7/week

      ACTIVITY  how much you worked, not scored
        ≥ $50 so far (start $100) · 14 prompts/day (start 10) · $0.71/prompt (start $1.43)
        1h24m active/day · 3 sessions · 2 /clear · 9 compacts · 3 /model · 1 interrupt · opus-5-5 180% of $ · 7d limit peak 60%

      API-equivalent estimate, not a bill · every week: cc-spend record --all · fixes: cc-spend insights"
    `);
    const colored = formatRecord(view(), true);
    // On target green, off target red; better green, worse red.
    expect(colored).toContain("\x1b[1;38;2;80;220;120m$25\x1b[0m");
    expect(colored).toContain("\x1b[1;38;2;248;105;107m50%\x1b[0m");
    expect(colored).toContain("\x1b[1;38;2;80;220;120m▼ 50% better\x1b[0m");
    expect(colored).toContain("\x1b[1;38;2;248;105;107m▲ 30pt worse\x1b[0m");
  });

  it("too early: no comparison, no changes; aims still colored", () => {
    const early = view({ today: "2026-11-20", live: { ...live, days: 2 } });
    expect(strip(formatRecord(early, false))).toMatchInlineSnapshot(`
      "RECORD #2  Nov 19 → Nov 25  ▕██████░░░░░░░░░░░░░░▏ day 2 of 7

      HOW YOU'RE DOING  ●●●●○  4 of 5 habits on target
        Too early to compare: day 2. Numbers settle after day 3.

      HABIT                NOW   TARGET   TREND
      cost of new work     $25    < $33   ██▅
      wasted $             50%    < 10%   ▃▂▅
      cache hits           95%    ≥ 90%   ▇▇█
      cache rebuilds        4%    < 10%   ▂▂▁
      history re-reads     40%    < 54%   ▅▅▄

      FIX NEXT
        ✖ wasted $ 50%            → /compact earlier · ~$70/week
            share of $ the fixes in cc-spend insights would save

      FOCUS THIS WEEK  /compact before breaks (R4 Prompt cache re-paid)
        cache hits 80% → 95% now

      ACTIVITY  how much you worked, not scored
        ≥ $50 so far (start $100) · 35 prompts/day (start 10) · $0.71/prompt (start $1.43)
        3h30m active/day · 3 sessions · 2 /clear · 9 compacts · 3 /model · 1 interrupt · opus-5-5 180% of $ · 7d limit peak 60%

      API-equivalent estimate, not a bill · every week: cc-spend record --all · fixes: cc-spend insights"
    `);
    expect(formatRecord(early, true)).toContain("\x1b[1;38;2;80;220;120m$25\x1b[0m");
  });

  it("no start, no previous record, no habits, no focus, no limits, no $", () => {
    const bare = snap({
      usd: 0,
      growth: 0,
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      habits: null,
      rules: {},
      models: {},
      peak7d: null,
      sessions: 0,
      activeMs: 0,
    });
    expect(
      strip(
        formatRecord(
          view({ file: { ...emptyRecords(), current: { ...current, focus: null } }, live: bare }),
          false,
        ),
      ),
    ).toMatchInlineSnapshot(`
      "RECORD #2  Nov 19 → Nov 25  ▕██████████████░░░░░░▏ day 5 of 7

      HOW YOU'RE DOING    0 of 0 habits on target
        No start to compare with: no use in the 7 days before record #1.

      HABIT                NOW   TARGET   TREND
      cost of new work       —    < $33   ·
      wasted $               —    < 10%   ·
      cache hits             —    ≥ 90%   ·
      cache rebuilds         —    < 10%   ·
      history re-reads       —    < 54%   ·

      ACTIVITY  how much you worked, not scored
        $0 so far
        0h00m active/day · 0 sessions

      API-equivalent estimate, not a bill · every week: cc-spend record --all · fixes: cc-spend insights"
    `);
  });

  it("against the start: costlier rates, same rates, a worse focus, an unknown rule", () => {
    const costlier = { ...live, days: 7, usd: 101, rules: { ...snap().rules, R10: 60 } };
    expect(
      strip(formatRecord(view({ live: costlier, file: { ...view().file, closed: [] } }), false)),
    ).toMatchInlineSnapshot(`
      "RECORD #2  Nov 19 → Nov 25  ▕██████████████░░░░░░▏ day 5 of 7

      HOW YOU'RE DOING  ●●●○○  3 of 5 habits on target
        new work costs 1% more than at your start · ~$1/week more

      HABIT                NOW   TARGET   TREND   VS YOUR START
      cost of new work     $51    < $33   ██      ≈ same
      wasted $             30%    < 10%   ▃▃      ≈ same
      cache hits           95%    ≥ 90%   ▇█      ▲ 15pt better
      cache rebuilds        2%    < 10%   ▂▁      ▼ 18pt better
      history re-reads     20%    < 54%   ▅▂      ▼ 30pt better

      FIX NEXT
        ✖ cost of new work $51    → /clear between tasks · ~$60/week
            $ per 1M tokens of new output and context: lower means less re-reading
        ✖ wasted $ 30%            → /compact before breaks · ~$20/week
            share of $ the fixes in cc-spend insights would save

      FOCUS THIS WEEK  /compact before breaks (R4 Prompt cache re-paid)
        cache hits 80% → 95% now  ✔ better, keep going

      CHANGED MOST vs your start
        ▲ Most spend re-reads context          +$10/week

      ACTIVITY  how much you worked, not scored
        ≥ $101 so far (start $100) · 10 prompts/day (start 10) · $1.44/prompt (start $1.43)
        1h00m active/day · 3 sessions · 2 /clear · 9 compacts · 3 /model · 1 interrupt · opus-5-5 89% of $ · 7d limit peak 60%

      API-equivalent estimate, not a bill · every week: cc-spend record --all · fixes: cc-spend insights"
    `);
    const same = strip(
      formatRecord(
        view({
          live: { ...snap(), days: 5 },
          file: { ...view().file, closed: [], current: { ...current, focus: "R1", focusShare: 0 } },
        }),
        false,
      ),
    );
    expect(same).toContain("new work costs the same as at your start");
    expect(same).toMatch(/cost of new work\s+\$50\s+< \$33\s+\S+\s+≈ same/);
    expect(same).toContain("share of $ 0% → 0% now  ≈ same");
    const focusWorse = strip(
      formatRecord(view({ live: { ...live, cacheRead: 50, input: 50 } }), false),
    );
    expect(focusWorse).toContain("cache hits 80% → 50% now  ✖ worse");
    const unknown = strip(
      formatRecord(
        view({ file: { ...view().file, current: { ...current, focus: "R99" } } }),
        false,
      ),
    );
    expect(unknown).toContain("FOCUS THIS WEEK   (R99 )");
    const zeroBase = strip(
      formatRecord(
        view({ file: { ...view().file, closed: [], baseline: snap({ growth: 1, usd: 0 }) } }),
        false,
      ),
    );
    expect(zeroBase).not.toContain("new work costs");
    expect(zeroBase).toMatch(/cost of new work\s+\$25\s+< \$33\s+\S+\s+≈ same/); // from $0 there is no %
  });

  it("a record that closed since the last look comes first", () => {
    const one = { ...prevEntry, n: 1 };
    const two: RecordEntry = { ...prevEntry, n: 2, focus: "R1", focusShare: 0.5 };
    const file = {
      ...emptyRecords(),
      baseline: snap(),
      current: { ...current, n: 3 },
      closed: [one, two],
    };
    expect(strip(formatRecord(view({ file, closedNow: two }), false)).split("\n\n")[0])
      .toMatchInlineSnapshot(`
      "RECORD #2 DONE  Nov 12 → Nov 18  1 of 5 habits on target
        0 of 5 habits better than the week before
        focus subagents on Sonnet: CLAUDE_CODE_SUBAGENT_MODEL=sonnet: ✔ kept"
    `);
    const first = strip(
      formatRecord(
        view({
          file: { ...file, closed: [one] },
          closedNow: { ...one, focus: "R10", focusShare: 0.2 },
        }),
        false,
      ),
    );
    expect(first).toContain("better than your start");
    expect(first).toContain("focus /clear between tasks: ≈ no change");
    const slipped = strip(
      formatRecord(
        view({
          file: { ...file, closed: [one], baseline: snap({ usdCarry: 10 }) },
          closedNow: { ...one, focus: "R10" },
        }),
        false,
      ),
    );
    expect(slipped).toContain("✖ slipped");
    const noStart = strip(
      formatRecord(
        view({
          file: { ...file, baseline: null, closed: [one] },
          closedNow: { ...one, focus: null },
        }),
        false,
      ),
    );
    expect(noStart).not.toContain("habits better than");
    expect(noStart).not.toContain("focus ");
    const unknownRule = strip(
      formatRecord(view({ closedNow: { ...one, focus: "R99", focusShare: 1 } }), false),
    );
    expect(unknownRule).toContain("focus R99: ✔ kept");
    expect(
      strip(formatRecord(view({ closedNow: { ...one, snapshot: undefined } }), false)),
    ).not.toContain("DONE");
  });

  it("edge values: a focus with no share, unknown values, no moves, no prompts counted", () => {
    const flat = snap({
      days: 7,
      usd: 0,
      habits: { prompt: 0, interrupt: 0, clear: 0, model: 0, compact: 0, autoCompact: 0 },
    });
    const file: RecordsFile = {
      ...emptyRecords(),
      baseline: snap({ habits: null }),
      current: { ...current, focus: "R1", focusShare: null },
      closed: [{ ...prevEntry, snapshot: flat }],
    };
    const text = strip(formatRecord(view({ file, live: flat }), false));
    expect(text).toContain("share of $ — now");
    expect(text).toContain("$0 so far (start $100) · 0 prompts/day\n");
    expect(text).not.toContain("CHANGED MOST");
  });

  it("a habit off target with no rule behind it; no $ verdict; a closed record with no snapshot", () => {
    const pricey = snap({ ...live, growth: 100_000, rules: { R99: 1 } }); // $500/M
    const text = strip(
      formatRecord(
        view({
          live: pricey,
          file: {
            ...view().file,
            baseline: snap({ growth: 0 }),
            closed: [{ ...prevEntry, snapshot: undefined }],
          },
        }),
        false,
      ),
    );
    expect(text).toMatch(/✖ cost of new work \$500 +→ R99 · ~\$1\.40\/week$/m); // no action known: its id
    expect(text).toMatch(/HOW YOU'RE DOING .*\n\nHABIT/); // no $ verdict line
    const noRules = strip(
      formatRecord(view({ live: snap({ ...live, growth: 100_000, rules: {} }) }), false),
    );
    expect(noRules).toMatch(/✖ cost of new work \$500 +→ \/clear between tasks/); // R10 by default
    const zero = strip(
      formatRecord(
        view({
          live: snap({ ...live, usd: 0, growth: 1 }),
          file: { ...view().file, baseline: snap({ usd: 0, growth: 1 }), closed: [] },
        }),
        false,
      ),
    );
    expect(zero).toMatch(/cost of new work +\$0 +< \$33 +▁▁ /);
  });

  it("no record yet", () => {
    expect(formatRecord(view({ file: emptyRecords() }), false)).toContain("No record yet");
    expect(formatRecord(view({ live: null }), false)).toContain("No record yet");
  });
});

describe("focusProgress, onTarget, trendReference, withTrends", () => {
  const entry: RecordEntry = { n: 1, from: "a", to: "b", focus: "R11", focusShare: 0.3 };

  it("a focus with a habit is judged by that habit; without one, by its share of $", () => {
    expect(focusProgress(entry, snap({ usdRewrite: 5 }), snap())).toMatchObject({
      was: 0.2,
      now: 0.05,
      change: "better",
    });
    expect(focusProgress(entry, snap(), null)).toMatchObject({ metric: null, was: 0.3, now: 0 });
    expect(focusProgress({ ...entry, focus: null }, snap(), snap())).toBeNull();
    expect(focusProgress({ ...entry, focus: "R1" }, snap({ usd: 0 }), snap())).toMatchObject({
      now: null,
      change: null,
    });
  });

  it("onTarget counts the habits that meet their aim, out of those known", () => {
    expect(onTarget(snap())).toEqual({ met: 1, of: 5 }); // re-reading 50% < 54%
    expect(onTarget(snap({ usd: 0, growth: 0, cacheRead: 0, input: 0, cacheWrite: 0 }))).toEqual({
      met: 0,
      of: 0,
    });
  });

  it("trendReference: the last closed record, else the start", () => {
    const closed: RecordEntry = { ...entry, snapshot: snap({ usd: 7 }) };
    expect(trendReference({ ...emptyRecords(), baseline: snap(), closed: [closed] })?.usd).toBe(7);
    expect(trendReference({ ...emptyRecords(), baseline: snap() })?.usd).toBe(100);
    expect(trendReference(emptyRecords())).toBeNull();
    expect(trendName({ ...emptyRecords(), closed: [closed] })).toBe("last week");
    expect(trendName(emptyRecords())).toBe("your start");
  });

  it("withTrends: $/week against the reference, a rising one ranks up; snoozed last, no-$ first", () => {
    const finding = (id: string, usd: number | null, fields: Partial<Finding> = {}): Finding => ({
      id,
      title: id,
      usd,
      window: "week",
      evidence: "",
      fix: { kind: "habit", text: "" },
      snoozedUntil: null,
      ...fields,
    });
    const ranked = withTrends(
      [
        finding("R4", 25),
        finding("R5", 12),
        finding("R2", 30, { snoozedUntil: "2099-01-01" }),
        finding("R8", null),
        finding("R9", 30, { window: "month" }),
        finding("R7", 30, { window: "month" }), // ties R9: input order
      ],
      snap({ rules: { R4: 30, R5: 0 } }),
    );
    expect(ranked.map((f) => [f.id, f.trendUsdPerWeek])).toEqual([
      ["R8", null],
      ["R4", -5], // scores 25; R5 scores 12 + its rise 12 = 24
      ["R5", 12],
      ["R9", 7],
      ["R7", 7],
      ["R2", 30],
    ]);
    expect(withTrends([finding("R4", 5)], null)[0]?.trendUsdPerWeek).toBeNull();
  });
});

describe("formatAll", () => {
  it("baseline, closed and live rows with focus results and a trend", () => {
    const closed: RecordEntry = {
      n: 1,
      from: "2026-11-12",
      to: "2026-11-18",
      focus: "R10",
      focusShare: 0.6,
      snapshot: snap({ from: "2026-11-12", to: "2026-11-18" }),
    };
    const current: RecordEntry = {
      n: 2,
      from: "2026-11-19",
      to: "2026-11-25",
      focus: "R4",
      focusShare: 0.3,
    };
    const file: RecordsFile = {
      ...emptyRecords(),
      baseline: snap(),
      closed: [closed, { ...closed, n: 9, snapshot: undefined }],
      current,
    };
    const live = snap({
      from: "2026-11-19",
      days: 4,
      growth: 4_000_000,
      cacheRead: 95,
      input: 0,
      cacheWrite: 5,
    });
    expect(strip(formatAll({ file, live, today: "2026-11-22", closedNow: null }, false)))
      .toMatchInlineSnapshot(`
      "RECORDS  b = your start, the 7 days before record #1

       #  period              cost/M  wasted    hits rebuilt   $ total  focus  result
       b  Nov 5 → Nov 11         $50     30%     80%     20%      $100      —  
       1  Nov 12 → Nov 18        $50     30%     80%     20%      $100    R10  ≈
       2  Nov 19 → now           $25     30%     95%     20%     $100…     R4  ✔ so far
          trend                  ██▅     ▃▃▃     ▇▇█     ▂▂▂

      Next record: 7 days. The live one is on day 4."
    `);
    const colored = formatAll({ file, live, today: "2026-11-22", closedNow: null }, true);
    expect(colored).toContain("\x1b[1;38;2;80;220;120m$25\x1b[0m");
    expect(colored).toContain("\x1b[1;38;2;248;105;107m$50\x1b[0m");
    const results = strip(
      formatAll(
        {
          file: {
            ...file,
            baseline: null,
            closed: [
              { ...closed, focusShare: 0.1 },
              { ...closed, n: 2, focusShare: 0.5 },
            ],
          },
          live: null,
          today: "x",
          closedNow: null,
        },
        false,
      ),
    );
    expect(results).toMatch(/R10 {2}✖$/m);
    expect(results).toMatch(/R10 {2}≈$/m);
    const early = strip(
      formatAll({ file, live: { ...live, days: 2 }, today: "2026-11-20", closedNow: null }, false),
    );
    expect(early).toMatch(/R4 {2}$/m);
    expect(
      formatAll({ file: emptyRecords(), live: null, today: "x", closedNow: null }, false),
    ).toContain("No record yet");
    const noCurrent = strip(
      formatAll(
        { file: { ...file, current: null }, live: null, today: "x", closedNow: null },
        false,
      ),
    );
    expect(noCurrent).toContain("The live one is on day 0.");
    const unknown = strip(
      formatAll(
        {
          file: { ...file, baseline: snap({ usd: 0, growth: 0 }) },
          live: null,
          today: "x",
          closedNow: null,
        },
        false,
      ),
    );
    expect(unknown).toMatch(/ b {2}Nov 5 → Nov 11\s+—/);
  });
});

describe("recordJson", () => {
  it("every snapshot with its habit values", () => {
    const current: RecordEntry = { n: 1, from: "a", to: "b", focus: null, focusShare: null };
    const json = recordJson({
      file: {
        ...emptyRecords(),
        baseline: snap(),
        current,
        closed: [{ ...current, snapshot: snap() }],
      },
      live: snap(),
      today: "x",
      closedNow: null,
    }) as {
      baseline: { values: Record<string, number> };
      closed: Array<{ snapshot: { values: Record<string, number> } }>;
      current: { snapshot: { values: Record<string, number> } };
    };
    expect(json.baseline.values.perMTok).toBe(50);
    expect(json.closed[0]?.snapshot.values.resend).toBe(0.2);
    expect(json.current.snapshot.values.cacheReads).toBe(0.8);
    expect(recordJson({ file: emptyRecords(), live: null, today: "x", closedNow: null })).toEqual({
      days: 7,
      baseline: null,
      closed: [],
      current: null,
    });
  });
});
