# 2026-11-15 - Cache what-ifs in the index; coach findings from them

## Status

Accepted

## Context

A 30-day look at both accounts (about $1,530 API-equivalent) showed where the
coach was wrong or silent:

- 65% of $ was at a context above 200k, but R5 counted only the cache reads
  of that part. A miss there re-writes the deep part at the 1.25x rate, and
  R11 counted it as a plain rewrite.
- Misses after a 5-60 min gap re-paid about $260: $166 after a prompt and $94
  after a tool result (a long command, or a permission prompt left open). R4
  saw only the statusline's miss causes, with no tool.
- A 1h cache for everything would save at most $260 and cost about $328
  more on writes (2x instead of 1.25x input). `init` asks about it before
  there is any data, and nothing checked whether it pays.
- There were 40 `429 usage_limit_reached` errors, but R8 looked only at the
  forecast.
- `report`'s self-check flagged Sonnet 5.5 as mispriced. Claude Code 2.1.293
  billed its cache reads at $0.20; later builds bill them at $0.10, the
  table's rate. The check averaged every run.
- Claude Code's own cost-state counts about 11% more than the transcripts.
  The limit forecasts and `usdPerPercentWeek` use the statusline's $ (Claude
  Code's) and the measured %, so the forecasts already include that overhead.
  Only transcript $ (the reports and findings) leaves it out.

## Decision

- `addTurn` (`src/transcript-parse.ts`) adds four rollup fields from the turn's
  rewrite $ and its gap to the previous turn of the thread: `deepRewriteUsd`,
  `ttlSaveUsd`, `oneHourExtraUsd`, `toolWaitRewriteUsd`. The index keeps the
  gap, the last tool and whether a tool result came, in `offsets.json` (`at`,
  `tool`, `afterTool`), and adds the session's `toolWaitUsd` per tool.
  `PRICES_VERSION` `.4` re-indexes the history.
- R5 = deep reads + `deepRewriteUsd`. R11 subtracts `deepRewriteUsd`.
- R4 = the larger of the statusline's miss $ and the tool-wait $ (the same
  misses from two sources), with the top tools in the evidence.
- New R13: per project, `ttlSaveUsd` − `oneHourExtraUsd`. It fires only for
  the projects where this is positive, with the fix `promptCacheTtl=1h`.
- R8 also fires on `429 usage_limit_reached` in the window's sessions.
- Each $ finding gets `weekPct` when `usdPerPercentWeek` is known, and
  `insights` prints `(≈N% of 7d/week)`.
- `selfCheck` compares only each model's newest Claude Code run.
- The 11% overhead is not added to the forecasts: they already include it.

## Options considered

| Option                                    | Why not / why                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Scale forecasts by the cost-state ratio   | The forecasts use Claude Code's $ and the measured %, so this would count the overhead twice      |
| R4 = statusline $ + tool-wait $           | Both count the same misses                                                                        |
| One global R13 verdict                    | One project with long breaks hides behind many with short ones; the setting can be per project    |
| Re-weight finding rank in weeks with 429s | All $ findings scale the same; R8 (no $) already ranks first, so making it fire on 429s is enough |

## Consequences

- R5's $ grows, and R11's falls by the same deep part.
- The gap is measured from the previous turn's time. A gap with the user
  idle and the tool done is counted as a tool wait. The tool is the last
  `tool_use` before the result, so parallel tool calls are charged to the
  last one.
- `weekPct` uses transcript $, so it is a floor.

## Verification

`src/transcript-parse.spec.ts` (what-ifs), `src/transcript-index.spec.ts`
(tool wait across passes), `src/rules.spec.ts` (R4, R5, R8, R11, R13,
`weekPct`), `src/insights.spec.ts`, `src/report.spec.ts` (newest run). Manual
test plan Q36-Q39.
