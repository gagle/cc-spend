/** Terminal notices printed instead of booting a UI. Plain ANSI, no dependency — so the message shows
 * at Node's own startup speed. */

export interface NoticeStyle {
  readonly color: boolean;
}

export function noticeStyle(
  stream: { readonly isTTY?: boolean } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): NoticeStyle {
  return { color: stream.isTTY === true && env.NO_COLOR === undefined && env.TERM !== "dumb" };
}

function paint(style: NoticeStyle, code: string, text: string): string {
  return style.color ? `\x1b[${code}m${text}\x1b[0m` : text;
}

const PLAN_NAMES: Readonly<Record<string, string>> = {
  claude_pro: "Claude Pro",
  claude_max: "Claude Max",
  claude_team: "Claude Team",
  claude_enterprise: "Claude Enterprise",
};

export function planName(planType: string | null | undefined): string {
  if (!planType) return "no Claude login";
  return PLAN_NAMES[planType] ?? planType;
}

/** Why `calendar` does not open on this account. `unknown`: the plan was never detected yet. */
export function calendarUnavailableNotice(
  style: NoticeStyle,
  planType: string | null | undefined,
  reason: "subscription" | "unknown",
): string {
  const dim = (text: string): string => paint(style, "2", text);
  const accent = (text: string): string => paint(style, "38;2;220;200;0", text);
  const lines =
    reason === "subscription"
      ? [
          `👤 Your plan: ${accent(planName(planType))}`,
          "",
          "📅 The calendar plans a monthly $ budget over your work days.",
          "   It is for Claude Team / Enterprise accounts with a spend cap.",
          "",
          "Your plan has seat limits instead. The statusline shows them:",
          `   ⏱  5-hour and 7-day usage   ${dim("(fresh at session start)")}`,
          `   🎫 usage credits             ${dim("(when they are on)")}`,
          `   🔥 prompt-cache cost of your next message`,
          "",
          `Set it up with: ${accent("cc-spend statusline")}`,
        ]
      : [
          `🔍 Plan not detected yet ${dim(`(${planName(planType)})`)}`,
          "",
          "📅 The calendar is for Claude Team / Enterprise dollar budgets.",
          "   Start one Claude Code session with the statusline installed",
          "   so cc-spend can detect your plan, then run this again.",
          "",
          `Install the statusline: ${accent("cc-spend statusline")}`,
        ];
  return lines.join("\n");
}
