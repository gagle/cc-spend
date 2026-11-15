# 2026-11-15 - cc-spend names itself on every request; limit-reset grants removed

## Status

Accepted

## Context

The usage fetch sent `User-Agent: claude-cli/2.1.319 (external, cli) cc-spend` with `?cedar_ember=1`. The
server returns the limit-reset grants (`cedar_ember`) only to a Claude Code client; with another user agent
it answers `ineligible_reason: "surface"`. Getting them meant presenting cc-spend as Claude Code. The public
API docs ask integrations to identify themselves (`YourApp/1.0.0 (https://yourapp.com)`).

## Decision

- Every request in `src/anthropic-usage.ts` sends `cc-spend/<package version> (+https://github.com/gagle/cc-spend)`
  (`userAgent()`); no request sends a Claude Code user agent.
- `/api/oauth/usage` is read without `cedar_ember`. The `resets` statusline part, `ApiResetGrant` and
  `ApiCache.resets` are gone; an old `resets` id in `statusline.json` drops out in `parseLayout`.
- Layout migration 1 → 2 stays as a version-only step, so version 2 files keep their number.

## Options considered

| Option                                    | Why not / why                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| Keep the `claude-cli/` user agent         | Impersonates Claude Code to pass a server gate, for every user of a public package |
| Honest user agent, keep the resets code   | Always empty: dead code                                                            |
| Honest user agent, remove resets (chosen) | Windows, credits and plan facts do not depend on the gate                          |

## Consequences

The statusline no longer shows `↺ N resets`; Claude Code's `/usage` still does. A stale user-agent version
cannot happen again: it comes from `package.json`.

## Verification

`src/anthropic-usage.spec.ts` (user agent on usage and profile calls, no `cedar_ember`),
`src/statusline-layout.spec.ts` (saved `resets` id drops), manual test plan P14.
