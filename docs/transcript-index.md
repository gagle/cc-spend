# Transcript index and `report`

Where the per-model, per-project, per-subagent $ comes from. Local files only,
never on the render path.

## Reader (`src/transcript-index.ts`, `src/transcript-parse.ts`)

```
~/.claude/projects/<project>/<session>.jsonl                      scope main
~/.claude/projects/<project>/<session>/subagents/agent-*.jsonl    scope subagent:<agentType from .meta.json>
        │  bytes past the saved offset, complete lines only
        ▼
parseTurn ─ assistant lines with message.usage (not <synthetic>)
        │  dedupe on requestId|message.id (Claude Code repeats the line per content block)
        ▼
priceTurn ─ src/pricing.ts; 5m and 1h cache writes priced apart; speed "fast" doubles
        ▼
owner = account whose sessions-map.json has the session id, else "unattributed";
        a session several accounts know: the login at the turn's time
        (account-log.json), else the account that saw it last
        ▼
<owner>/index/habits.json   local day → prompt, interrupt, clear, model, compact, autoCompact
<owner>/index/YYYY-MM.json  rows: day × project × model × scope × speed → Rollup
<owner>/index/sessions.json session → totals, first/last time, project, branch, models,
                            turnMs, thinkingMs, hookRuns, entrypoint, mcpLoaded, mcpUsed,
                            attributedUsd, apiErrors, ccRuns
```

- Offsets live in `~/.config/cc-spend/index/offsets.json` with the size,
  mtime, the last 64 dedupe keys and the last turn's context (`context`) per
  file. The offset of a transcript no longer listed (Claude Code deleted it) is dropped. An unchanged file is skipped; a
  file smaller than its offset was rewritten and is read from the start.
- A pass starts no new file after 8 MB or 2 s (`PASS_BYTES`, `PASS_MS`); the
  rest is `bytesBehind` in `index/last-pass.json`. `catchUp` has no budget.
- One pass at a time: `index/index.lock` (stale after 2 min).
- A response that took several API requests carries `usage.iterations`; the
  top-level counts are their sum. `priceTurn` prices each request on its own
  (Haiku 5.5's long-prompt tier goes by one request's prompt), and
  `contextTokens` is the last request's prompt, not the sum.
- `usage.speed` "fast" and `usage.inference_geo` "us" select the fast and the
  1.1× US-only prices (see `docs/prompt-cache.md`).
- Re-price: `index/prices.json` holds the `PRICES_VERSION` (`src/pricing.ts`)
  the index was built at (the price date, plus `.N` for a rebuild with no
  price change). When a pass finds an older one (or none, with an
  index present), it copies every owner's index to
  `index/backup-prices-<old>/`, empties it, and rebuilds it from all
  transcripts in that pass, unbounded, keeping the lock fresh. Rows and
  sessions the rebuild did not produce (their transcripts are gone) come back
  from the copy at the prices they were stored with; a rebuilt row with fewer
  turns than before (a deleted transcript shared it, `rowsShort`) gets the
  missing part back (`missingPart`): exact token and turn counts, the main $
  fields at the old row's own $ per token. The
  result is in `last-pass.json` (`repriced`). A crashed re-price restarts from
  the copy. A newer `PRICES_VERSION` is never re-priced down.
- Attribution: `attributionSkill` and `attributionMcpServer` on a priced line
  (Claude Code's own, not in the public docs) add that turn's $ to the
  session's `attributedUsd` under `skill:<name>` / `mcp:<server>`.
- API errors (`parseApiError`): `<synthetic>` lines with `isApiErrorMessage`
  count per session in `apiErrors`, keyed `<apiErrorStatus> <apiError>`
  (`429 usage_limit_reached`), deduped like turns.
- An unknown model counts tokens with no $ (`unpricedTurns`); totals that
  include one are a floor (`feed.json.spend.isFloor`).
- Thinking $ is the output $ share of `thinking_tokens` (an estimate).
- Web searches are priced at $10 per 1,000 (`WEB_SEARCH_USD`) on any model;
  web fetches stay a count (no fee of their own).
- Efficiency split (`splitTurn`, antiburn's): per thread (file), a turn's
  cache-read $ is carry; its fresh input (input + cache write) that grows the
  context past the thread's previous turn is new work, the rest a rewrite;
  output is new work. Rollups add `growth` (context growth + output),
  `freshSplit`, `rewriteTokens`, `usdNewWork`, `usdCarry`, `usdRewrite`. A file
  resumed from an offset with no saved `context` skips the split for one turn;
  rows indexed before 2026-10-18 read these as 0 (`loadRollups` fills missing
  fields).
- Cache what-ifs (`addTurn`, from the split's rewrite $; `PRICES_VERSION` `.4`
  re-indexed them): `deepRewriteUsd` is a rewrite's share above 200k
  (`DEEP_CONTEXT_TOKENS`); `oneHourExtraUsd` is every 5m write at the 1h − 5m
  rate. A turn's gap is the time since the thread's previous turn (`offsets.json`
  `at` carries it across passes). A gap of 5-60 min adds the rewrite × (1 −
  read ÷ 5m-write rate) to `ttlSaveUsd`. A gap of 5 min or more after a
  `tool_result` user line adds the rewrite to `toolWaitRewriteUsd` and to the
  session's `toolWaitUsd` under the last tool called before it (`tool_use`
  name; `offsets.json` `tool` and `afterTool` carry them across passes). The
  rules use these in R4, R5, R11 and R13 (`docs/coach.md`).
- MCP (`parseMcpLoad`, `mcpServersUsed`): an `mcp_instructions_delta`
  attachment gives the servers whose instructions entered context and their
  size (4 characters per token) → `mcpLoaded`; every copy of an assistant line
  is read for `mcp__<server>__` tool uses → `mcpUsed`. Names are matched in
  Claude Code's tool-prefix form (`plugin:figma:figma` → `plugin_figma_figma`).
  Servers with no instructions and tool definitions are not in the transcript.
  Lines already indexed are not read again, so older sessions have none.
- Time and hooks (`parseActivity`): `system` lines `turn_duration`
  (`durationMs`) add `turnMs`, `stop_hook_summary` (`hookCount`) add
  `hookRuns`; an assistant line's `thinkingDurationMs` (on the first copy of
  the message, so the dedupe keeps it) adds `thinkingMs`; the first turn's
  `entrypoint` (cli, sdk-ts, …) is kept. System lines only extend a session the
  index already has. Sessions indexed before these fields read as zero.
- Habits (`parseHabit`): in main-session files, prompts, interrupts, `/clear`,
  `/model` and compactions add per owner and local day to `<owner>/index/habits.json`
  (`loadHabits`); `record` reads them (`docs/record.md`).
- Index files carry `schemaVersion` 1 and follow the downgrade guard in
  `docs/data-model.md`.

## When it runs

| Caller                                       | Pass                                                    |
| -------------------------------------------- | ------------------------------------------------------- |
| refresher (`runRefresh` in `src/refresh.ts`) | one bounded pass after the API call, before `feed.json` |
| `report`                                     | `catchUp`, then rebuilds `feed.json`                    |
| render                                       | never                                                   |

## `report` (`src/report.ts`)

`cc-spend report [today|week|month|30d|YYYY-MM] [--by model|project|component|subagent|session|day] [--json] [--account <key|unattributed>]`

`cc-spend report --session <id or prefix> [--json]`

- Ranges are local days: `week` = rolling 7 days, `month` = local month to date.
- Visual by default (no flag), top to bottom:
  - the total (`+` when an unpriced turn makes it a floor), $ per day, and the
    change against the same number of days just before the range
    (`previousUsd`; green down, red up);
  - a sparkline of $ per day (`daily`: each local day from the range start to
    today; a `YYYY-MM` range stops at the month's last day);
  - "WHAT THE $ PAID FOR": one stacked bar of new work, history re-reads
    (carry) and cache rebuilds (rewrite), plus `other` for what the split does
    not cover (web searches, rows indexed before 2026-10-18); hidden when no
    row has the split;
  - one row per `--by` value: the same stacked bar scaled to the largest row,
    the $ and its share. `--by day` lists days in time order, the rest rank by
    $ and show the top 15 (`--json` has all). `--by session` labels a row with
    Claude Code's session name when `sessions-map.json` has one, draws a plain
    bar (the index keeps a session's total only) and adds the share of the 7d
    limit (`usd ÷ usdPerPercentWeek`) and $ per 100 changed lines
    (`sessions-map.json`);
  - one dim line: thinking $, subagent $ and share, web searches, turn time,
    requests that hit the usage limit (`429 usage_limit_reached`) and other API
    errors; the top 3 skills and MCP servers Claude Code attributed $ to; then
    the unpriced, unattributed, Claude Code total and self-check notes.
- Money is whole $ from $10 up. `--json` prints the `Report` as built, hook runs
  and entrypoints included.
- `--session` (`src/session-report.ts`): finds the one session whose id starts
  with the argument (main file and subagent files), reads them whole through
  the session model (`docs/live.md`) and prints $ per time slot, the running
  total, event marks (`!` cold re-write, `C` compaction, `S` subagent start) and
  where the $ went. Several matches → an error listing them.
- `dayBreakdown(owner, day)`: one local day's $ with the top 3 sessions (last
  active that day), models and projects; the calendar's `d` key shows it.
- Claude Code's own cost (`parseCostState`): the `cost-state` line Claude
  Code writes when a run ends (not in the public docs) holds the run's
  `totalCostUSD`, its `startTime` and per-model tokens and $ (`modelUsage`).
  The session keeps one entry per run in `ccRuns`, keyed by `startTime`; a
  later reading of the same run replaces a smaller one (the total only
  grows). A resumed session starts a new run at $0.
- Self-check (`selfCheck`): per run and model in range, Claude Code's $
  against the same tokens at the table's prices (cache writes with no TTL
  split at the 5m rate, as Claude Code bills them). A gap over 1% on more than
  5 cents prints "Claude Code prices <model> N% higher|lower than this table: a
  price change, or fast mode." Haiku 5.5 is skipped: its price goes by each
  request's prompt size.
- `claudeCodeTotals`: for the sessions in range that Claude Code counted whole
  (a run starts no later than the first turn, and the runs add up to at
  least the transcripts' $), its total next to the index's. The report says
  how much more it counted: requests no transcript line records.

## Shared modules

The mod bundles Node-free modules. `src/node-free.spec.ts` fails when one of
them (or anything it imports) uses a `node:` module or a package.
