# Record: habits week by week

`src/record.ts` (pure, Node-free) and `src/record-store.ts` (files and the
index). A record is a period of local days (7 by default) that starts and ends
by itself. Each closed record is frozen and compared with the baseline (the 7
days before record #1) and with the record before it. Nothing to start or
stop by hand.

## Lifecycle (`advance`)

```
refresher pass with nothing behind (or `cc-spend record`)
  │
  ├─ no record yet → baseline = snapshot of the 7 days before today
  │                  (null with no turns), record #1 = today .. today + days − 1,
  │                  focus = top rule of the baseline
  │
  └─ today past the record's last day → snapshot of the whole record
        ├─ turns > 0 → frozen into `closed` (newest 52, KEEP_RECORDS),
        │              `unseen` = its number, next record starts the day after,
        │              focus = top rule of the record that closed
        └─ no turns  → not kept; the same number starts again today
```

- The refresher calls `advanceRecord` only after an index pass that left
  `bytesBehind` 0, so a half-read index never freezes wrong numbers. A pass that
  could not take the lock skips it.
- `record --days N` (1-90) sets the length of the next record; the live one
  keeps its own.
- The focus is the rule with the most $ in the source snapshot, R6 and R8
  excepted (`pickFocus`), with its share of $ (`focusShare`).
- The focus is judged by the habit its fix moves when it has one (`RULE_HABIT`:
  R4 → cache hits, R10 → history re-reads, R11 → cache rebuilds), from the
  snapshot it was picked from to now, so the focus line and the habits table
  show the same number (`focusProgress`); any other rule by its share of $.

## Snapshot (`snapshotFor`)

Over local days `from..to` of the account (never `unattributed`):

| Field                                                                               | From                                                                                                      |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `usd`, tokens, `growth`, `usdCarry`, `usdRewrite`, `turns`, `models`, `subagentUsd` | the index rollups in range (`rowsInRange`); `isFloor` when a row has an unpriced turn                     |
| `sessions`, `activeMs`                                                              | `sessions.json` sessions whose last activity is in range; `turnMs` summed                                 |
| `habits`                                                                            | `index/habits.json` days in range, summed; null when no day in range was counted                          |
| `rules`                                                                             | `coach` over the same rows, sessions, miss causes and instruction files; no limits, no budget, no snoozes |
| `peak5h`, `peak7d`                                                                  | highest % of the `limits.json` samples in range                                                           |

A live record is a snapshot from its first day to today; `days` is the days so
far (`daysSoFar`), so rates and $ per week are fair against whole records.

## Habits (the scored part)

The same aims as the `live` advisor (`src/advisor.ts`, `src/session-model.ts`):

| Habit (on screen) | Id           | Value                                                   | Aim   |
| ----------------- | ------------ | ------------------------------------------------------- | ----- |
| cost of new work  | `perMTok`    | `usd ÷ growth × 1M`                                     | < $33 |
| wasted $          | `avoidable`  | Σ rule $ but R6, R8, R10, R11, capped at `usd`, ÷ `usd` | < 10% |
| cache hits        | `cacheReads` | `cacheRead ÷ (input + cacheRead + cacheWrite)`          | ≥ 90% |
| cache rebuilds    | `resend`     | `usdRewrite ÷ usd`                                      | < 10% |
| history re-reads  | `reread`     | `usdCarry ÷ usd`                                        | < 54% |

The screen never shows a term it does not explain: each habit off its aim gets
its `means` text under its fix.

R10 and R11 are the re-reading and re-sending scores already; R6 is relative to
your median; R8 has no $. Rules overlap, so the sum is capped.

- `changeOf`: a $ value changes when it moves 3% or more (`SAME_RELATIVE`), a
  share when it moves 2 points or more (`SAME_POINTS`); less is `≈`.
- `savedPerWeek`: `(baseline $/MTok − now $/MTok) × new work × 7 ÷ days`.
- `ruleMoves`: each rule's $ per 7 days, after − before; at least $0.50
  (`MIN_MOVE_USD`), the two that dropped most and the two that grew most.
- Raw $, prompts, `$/prompt`, commands, active time, top model and the 7d peak
  are VOLUME: shown, never scored (they measure how much work, not how).

## Habit counts in the index

`parseHabit` (`src/transcript-parse.ts`) reads main-session lines only; the
index adds them per owner and local day to `index/habits.json`. Not in the
public docs; checked on real files 2026-11-12:

| Count                    | Line                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `prompt`                 | `user`, no `isMeta`, not sidechain or compact summary, text not starting with `<` or `[Request interrupted` |
| `interrupt`              | text starting `[Request interrupted`                                                                        |
| `clear`, `model`         | text starting `<command-name>/clear` / `<command-name>/model`                                               |
| `compact`, `autoCompact` | `compact_boundary` with trigger `manual` / anything else                                                    |

`cc-spend doctor` warns when a day of the last 7 with 10 or more main-session
turns counted 0 prompts (`checkPromptCounts` in `src/doctor.ts`): the sign that
the format changed. `PRICES_VERSION` `.2` rebuilt the index once so the counts cover every
transcript still on disk; a day whose transcripts are gone keeps its old counts.

## Surfaces

- `cc-spend record`: catches the index up, advances, prints the live record,
  then marks a closed record seen and rewrites `feed.json`. Top to bottom:
  - header: the record's days with a progress bar;
  - HOW YOU'RE DOING: one dot per habit (green on target, red off,
    `onTarget`), then the $ verdict against the start: how much less (or more)
    new work costs and the $ per week saved (`savedPerWeek`);
  - the habits table: now (green on target, red off, from day 1), the target,
    a trend over the start, the newest 5 closed records and now (`trendline`:
    0-100% for a share, 0 to the largest $ for $, so a flat habit draws flat),
    and the change against last week (the last closed record) or, with none,
    the start: `▼ 27% better` green, `▲ 3pt worse` red, `≈ same` dim;
  - FIX NEXT: each habit off its aim with the action of the rule that moves it
    (`ruleFor`: its `RULE_HABIT` rule, else the costliest matching rule, else
    R10) and that rule's $ per week, then what the habit means;
  - FOCUS THIS WEEK: the focus's action and rule, and its habit (or share of
    $) then → now with `✔ better, keep going`, `✖ worse` or `≈ same`;
  - CHANGED MOST: the moved rules (`ruleMoves`) against the same reference;
  - ACTIVITY (not scored): $, prompts per day and $ per prompt with the start's
    in parentheses; active time, sessions, commands, top model and the 7d peak.
    A record that closed since the last look prints first: habits on target,
    how many got better than the week before (or the start) and whether its
    focus was `✔ kept`, `✖ slipped` or `≈ no change`. Before day 3
    (`SETTLE_DAYS`) nothing is compared: no $ verdict, no change column, no moved
    rules.
- `--all`: one row per baseline, closed and live record, with a trend per
  habit on the same fixed scale. `--json`: every snapshot with its habit `values`.
- Statusline: `feed.json.record.notice` (`recordNotice`), e.g.
  `» record #2 done: 4/5 habits better · focus ✔ · cc-spend record` (`focus ✖`
  when it slipped, nothing when unchanged), comes before the weekly finding in
  the next-action part until `cc-spend record` runs.
- Trends for the coach: `withTrends` adds each finding's $ per week against
  `trendReference` (the last closed record, else the start) as
  `trendUsdPerWeek`, and ranks by $ per week + its rise, so a habit that is
  getting worse moves up (snoozed last, R8 first, as `coach` ranks). The
  refresher (`feed.json.advice`) and `insights` both apply it.
- `records.json` fields: `docs/data-model.md`.
