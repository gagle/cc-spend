# Coach: findings, `insights` and the coach part

Pure rules in `src/rules.ts` turn the index rollups (`docs/transcript-index.md`)
and the usage history (`docs/history-and-feed.md`) into findings with an
estimated avoidable $ and an exact fix. `src/insights.ts` loads the window and
runs them; the refresher writes them to `feed.json.advice`.

## Rules (window: rolling 7 days, or 30 with `--month`)

| ID  | Finding                      | Trigger                                                                                                          | $ estimate                                                                                                                                                               | Fix                                     |
| --- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| R1  | Subagents on a premium model | subagent rows on a model id with `opus`, `fable` or `mythos`                                                     | actual − the same text at `claude-sonnet-5-5`: each $ component × its rate ratio (cache writes follow input), × `tokenizerRatio` ~1.3 from a Claude 4.6-or-earlier model | env `CLAUDE_CODE_SUBAGENT_MODEL=sonnet` |
| R2  | Fast mode                    | rows with `speed` fast                                                                                           | the fast surcharge: actual − the same tokens at standard rates (2× → half; Opus 4.6 / 4.7 at 6× → five sixths)                                                           | setting `fastMode=false`                |
| R3  | High effort thinking         | thinking on turns at `xhigh`/`max`/`ultra`                                                                       | all of that thinking $ (the floor is unknown)                                                                                                                            | setting `effortLevel=high`              |
| R4  | Prompt cache re-paid         | `usage.missCauses` in the window; sessions' `toolWaitUsd` (a miss after a tool result and a 5+ min gap, by tool) | the larger of the two sources (they count the same misses), top three causes and tools                                                                                   | habit                                   |
| R5  | Deep context                 | turns with context over 200k tokens                                                                              | cache-read $ for the part above 200k + `deepRewriteUsd` (a rewrite's part above 200k)                                                                                    | setting `autoCompactWindow=200000`      |
| R6  | Outlier session              | ≥ 8 sessions; $ > max($2, 3 × median)                                                                            | Σ ($ − median)                                                                                                                                                           | `report <window> --by session`          |
| R8  | Running out early            | a window `at-risk` in the feed, today's budget passed, or `429 usage_limit_reached` in the window's sessions     | none                                                                                                                                                                     | habit                                   |
| R9  | Older model                  | a newer model of the family at the same or a lower price per text (rates × `tokenizerRatio`)                     | actual − repriced (as R1)                                                                                                                                                | `/model`                                |
| R10 | Most spend re-reads context  | cache-read $ > 57% of $                                                                                          | cache-read $                                                                                                                                                             | habit                                   |
| R7  | Unused MCP servers           | a session's `mcpLoaded` server not in its `mcpUsed`                                                              | instruction tokens × the session's turns at its cheapest model's cache-read rate (floor)                                                                                 | command `/mcp`                          |
| R11 | Context sent again and again | fresh input ÷ (fresh − rewrite) ≥ 2.35 (antiburn check 9)                                                        | rewrite $ − `deepRewriteUsd` (R5 has it)                                                                                                                                 | habit                                   |
| R12 | Large instruction files      | CLAUDE.md + MEMORY.md of a project over 2,000 tokens                                                             | tokens over 2,000 × main turns at the row's cache-read rate                                                                                                              | habit                                   |
| R13 | Cache expires in breaks      | per project, `ttlSaveUsd` > `oneHourExtraUsd`                                                                    | Σ over those projects of `ttlSaveUsd` − `oneHourExtraUsd` (see below)                                                                                                    | setting `promptCacheTtl=1h`             |

R7 sees only servers that send instructions (`docs/transcript-index.md`); tool
definitions are not in the transcript, so its $ is a floor. R11 and R7 need rows
and sessions indexed from 2026-10-18 on. R12's files (`instructionFiles` in
`src/insights.ts`): the global `~/.claude/CLAUDE.md` and its `@` imports (one
level), and per project CLAUDE.md, CLAUDE.local.md, .claude/CLAUDE.md and
the auto-memory MEMORY.md; size ÷ 4 = tokens. Parent-folder CLAUDE.md files
are not followed.

R13 is a what-if over the transcripts (`addTurn` in `src/transcript-parse.ts`):
`ttlSaveUsd` is the rewrite $ of turns 5-60 min after the previous one, × (1 −
cache-read ÷ 5m-write rate), what a 1h cache would have read instead;
`oneHourExtraUsd` is every 5m write priced at the 1h rate (2× input) − the 5m
rate (1.25×). It fires only where the first beats the second, so a project
with short breaks never gets the advice. The fix text names the projects'
`.claude/settings.json` when some projects do not pay.

Pro/Max: when the feed has `usdPerPercentWeek`, `coach` adds `weekPct` to each $
finding, its $ per week (a 30-day window × 7/30) ÷ $ per 1% of the 7d limit;
`insights` prints it as `(≈3% of 7d/week)`. Transcript $ is a floor (Claude
Code also bills requests no transcript line shows), so `weekPct` is too.

Ranking (`coach`): not snoozed first, then $ descending, a finding with no $
(R8) first; findings under $0.50 (`MIN_FINDING_USD`) drop; at most 10. Then
`withTrends` (`docs/record.md`) re-ranks by $ per week + its rise since the
last record, so a habit that is getting worse comes first.

## Rule texts (`RULE_INFO`)

Each rule's title, what it checks, why it costs money, how its $ is estimated
and the usual fix, plus a few-word `action` for the statusline, live once in
`RULE_INFO` (`src/rules.ts`). `coach` sets each
finding's `title` and `why` from it (the rule functions return only `id`, `usd`,
`evidence`, `fix`). `insights --rules` prints the catalog; the README table
"What `insights` checks" is generated from it, so `docs:drift` flags the
README when `src/rules.ts` changes.

## Surfaces

- `cc-spend insights [--week|--month] [--json] [--rules] [--snooze <rule> <N>d]`:
  catches the index up, rewrites `feed.json`, prints "YOU COULD SAVE" (the $ of
  the open findings), then each finding (a blank line between them): its title,
  a bar scaled to the largest $, the $ (and the share of the 7d limit on
  Pro/Max), its trend against last week or the start (`▲ +$13 vs last week`red,`▼`green, hidden under $0.50), then`→`the fix (the setting or command
  dimmed after it unless the text already names it), the evidence (home paths
  as`~/`) and `why`, dimmed. A finding with no $ (R8) says "costs time, not
  $". `--rules`prints every rule (checks, why, $, fix) and
  marks with`●`the ones found now;`--rules --json`gives the catalog with`found`. `--snooze R1 0d`clears a snooze. Snoozes live in`config.json` `snoozed` (rule → ISO end).
- Statusline part 14 `coach` ("Next action", `src/next-action.ts`): one short
  action, the most urgent first, from what the render already has (one small
  `feed.json` read, no transcripts):

  | When                                                                                                           | Shows                                                                                                                                                     |
  | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | cache warm, ≤ 90 s left, letting it expire costs ≥ $0.05                                                       | `» send now or /compact before the cache goes cold` (orange); with no cache part in the layout, `» send now or /compact · cache cold in 45s, then +$1.22` |
  | cache cold, the next message re-writes ≥ $0.50                                                                 | `» new task? /clear · same task? /compact first` (orange)                                                                                                 |
  | context within 20k of the auto-compact trigger (window − 33k: 167k on 200k, 967k on 1M; `context_window_size`) | `» /compact now, with a focus · auto-compact in 17k (at 167k)`                                                                                            |
  | context ≥ 150k tokens (`total_input_tokens`)                                                                   | `» /compact at the next break · 520k re-read each turn, ~$0.10`                                                                                           |
  | a 5h or 7d window `at-risk`                                                                                    | `» /model sonnet for routine steps · keep Opus for the hard ones`                                                                                         |
  | a record closed and `cc-spend record` not run since                                                            | `» record #2 done: 4/5 habits better · cc-spend record` (`feed.json.record.notice`)                                                                       |
  | else the first non-snoozed finding except R8                                                                   | `» <rule action> · ~$X/<window>` (`RULE_INFO.action`; the title in feeds written before it), `· ▲ up on last week` when its `trendUsdPerWeek` ≥ $0.50     |

  R8 is skipped there: the `warnings` part already shows when a limit runs
  out. On by default, on the second row before the limit warnings.

- `feed.json.advice`: the week's findings for the `/cost-tracker` mod. The CLI
  never writes Claude Code settings; a fix is text to copy.
