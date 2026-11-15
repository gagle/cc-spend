import { describe, expect, it } from "vitest";

import { calendarUnavailableNotice, noticeStyle, planName } from "./notice.js";

describe("notice.ts", () => {
  it("colors only on a TTY without NO_COLOR or TERM=dumb", () => {
    expect(noticeStyle({ isTTY: true }, {})).toEqual({ color: true });
    expect(noticeStyle({ isTTY: false }, {})).toEqual({ color: false });
    expect(noticeStyle({ isTTY: true }, { NO_COLOR: "1" })).toEqual({ color: false });
    expect(noticeStyle({ isTTY: true }, { TERM: "dumb" })).toEqual({ color: false });
    expect(noticeStyle().color).toBe(false); // vitest stdout is not a TTY
  });

  it("planName maps known org types", () => {
    expect(planName("claude_pro")).toBe("Claude Pro");
    expect(planName("weird")).toBe("weird");
    expect(planName(null)).toBe("no Claude login");
  });

  it("subscription and unknown variants", () => {
    const pro = calendarUnavailableNotice({ color: false }, "claude_max", "subscription");
    expect(pro).toContain("Claude Max");
    expect(pro).toContain("⏱");
    const unknown = calendarUnavailableNotice({ color: false }, undefined, "unknown");
    expect(unknown).toContain("Plan not detected yet");
  });

  it("no border, no title: the plan line comes first", () => {
    const plain = calendarUnavailableNotice({ color: false }, "claude_pro", "subscription");
    expect(plain.split("\n")[0]).toBe("👤 Your plan: Claude Pro");
    expect(plain).not.toMatch(/[╭╮╰╯│]|cc-spend calendar/);
    expect(calendarUnavailableNotice({ color: true }, "claude_pro", "subscription")).toContain("\x1b[");
  });
});
