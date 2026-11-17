#!/usr/bin/env node

// README screenshots, rendered by the real renderers (dist/) from made-up data in scripts/shots/.
// The shot list lives here and nowhere else. media/shots.json holds the sha256 of each shot's ANSI text:
//   check            re-render the ANSI text (no browser) and name every image whose output changed.
//   render [name…]   re-render, screenshot with headless Chrome into media/<name>.png, update the hash.
// The hash is of the ANSI text, not the PNG: Chrome builds do not give byte-identical PNGs.
// Run against a fresh build: `pnpm shots:check` and `pnpm shots` build first.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = pathToFileURL(path.join(ROOT, "dist")).href;
const HASHES = path.join(ROOT, "media", "shots.json");

// name → fixture module (scripts/shots/), its export, and the window title.
const SHOTS = {
  "statusline-pro": { module: "statusline.mjs", fn: "pro", title: "Claude Code · Pro" },
  "statusline-enterprise": {
    module: "statusline.mjs",
    fn: "enterprise",
    title: "Claude Code · Enterprise",
  },
  live: { module: "tui.mjs", fn: "live", title: "cc-spend live" },
  calendar: { module: "tui.mjs", fn: "calendar", title: "cc-spend calendar" },
  settings: { module: "tui.mjs", fn: "settings", title: "cc-spend settings" },
  record: { module: "coach.mjs", fn: "record", title: "cc-spend record" },
  insights: { module: "coach.mjs", fn: "insights", title: "cc-spend insights" },
};

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** One shot's ANSI blocks, rendered in a child with a fixed time zone and a throwaway HOME. */
function blocksOf(name) {
  const home = mkdtempSync(path.join(tmpdir(), "cc-spend-shot-"));
  try {
    const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), "_blocks", name], {
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TZ: "UTC", LANG: "C.UTF-8" },
      encoding: "utf8",
    });
    return JSON.parse(out);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const hashOf = (blocks) => createHash("sha256").update(JSON.stringify(blocks)).digest("hex");

const readHashes = () => (existsSync(HASHES) ? JSON.parse(readFileSync(HASHES, "utf8")) : {});

// ── ANSI SGR → a terminal-window HTML page ──

const BASE = [
  "#1d1f21",
  "#cc6666",
  "#b5bd68",
  "#f0c674",
  "#81a2be",
  "#b294bb",
  "#8abeb7",
  "#c5c8c6",
];
const BRIGHT = [
  "#666666",
  "#ff7b72",
  "#d7ff87",
  "#ffd75f",
  "#79c0ff",
  "#d2a8ff",
  "#a5f3fc",
  "#ffffff",
];

function color256(n) {
  if (n < 8) return BASE[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n < 232) {
    const steps = [0, 95, 135, 175, 215, 255];
    const i = n - 16;
    return `rgb(${steps[Math.floor(i / 36)]},${steps[Math.floor(i / 6) % 6]},${steps[i % 6]})`;
  }
  const grey = 8 + (n - 232) * 10;
  return `rgb(${grey},${grey},${grey})`;
}

const escapeHtml = (text) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function ansiToHtml(text) {
  let state = {};
  let out = "";
  // eslint-disable-next-line no-control-regex
  for (const part of text.split(/(\x1b\[[0-9;]*m)/)) {
    // eslint-disable-next-line no-control-regex
    const sgr = /^\x1b\[([0-9;]*)m$/.exec(part);
    if (!sgr) {
      if (part === "") continue;
      let { fg, bg } = state;
      if (state.inverse) [fg, bg] = [bg ?? "#0d1117", fg ?? "#c9d1d9"];
      const css = [
        fg && `color:${fg}`,
        bg && `background:${bg}`,
        state.bold && "font-weight:700",
        state.dim && "opacity:.55",
        state.italic && "font-style:italic",
        state.underline && "text-decoration:underline",
      ]
        .filter(Boolean)
        .join(";");
      out += css ? `<span style="${css}">${escapeHtml(part)}</span>` : escapeHtml(part);
      continue;
    }
    const codes = (sgr[1] === "" ? "0" : sgr[1]).split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 0) state = {};
      else if (code === 1) state.bold = true;
      else if (code === 2) state.dim = true;
      else if (code === 3) state.italic = true;
      else if (code === 4) state.underline = true;
      else if (code === 7) state.inverse = true;
      else if (code === 22) state.bold = state.dim = false;
      else if (code === 23) state.italic = false;
      else if (code === 24) state.underline = false;
      else if (code === 27) state.inverse = false;
      else if (code >= 30 && code <= 37) state.fg = BASE[code - 30];
      else if (code >= 90 && code <= 97) state.fg = BRIGHT[code - 90];
      else if (code >= 40 && code <= 47) state.bg = BASE[code - 40];
      else if (code >= 100 && code <= 107) state.bg = BRIGHT[code - 100];
      else if (code === 39) delete state.fg;
      else if (code === 49) delete state.bg;
      else if (code === 38 || code === 48) {
        const key = code === 38 ? "fg" : "bg";
        if (codes[i + 1] === 5) {
          state[key] = color256(codes[i + 2]);
          i += 2;
        } else if (codes[i + 1] === 2) {
          state[key] = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
          i += 4;
        }
      }
    }
  }
  return out;
}

function windowHtml(title, blocks) {
  const body = blocks
    .map((block) => `<pre>${ansiToHtml(block)}</pre>`)
    .join('<div class="gap"></div>');
  return `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:transparent}
.win{display:inline-block;margin:24px;background:#0d1117;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.45);border:1px solid #30363d;overflow:hidden}
.bar{height:30px;background:#161b22;display:flex;align-items:center;padding:0 12px;gap:8px;border-bottom:1px solid #30363d}
.dot{width:12px;height:12px;border-radius:50%}
.t{flex:1;text-align:center;color:#8b949e;font:13px -apple-system,system-ui,sans-serif;margin-right:52px}
.c{padding:16px 20px}
pre{margin:0;color:#c9d1d9;font:14px/1.45 Menlo,"SF Mono",monospace;white-space:pre}
.gap{height:14px;border-top:1px dashed #30363d;margin-top:14px}
</style><div class="win" id="w"><div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span class="t">${escapeHtml(title)}</span></div><div class="c">${body}</div></div>
<script>const r=document.getElementById("w").getBoundingClientRect();document.body.setAttribute("data-size",Math.ceil(r.width+48)+"x"+Math.ceil(r.height+48));</script>`;
}

/** Measure the window, then screenshot it at 2x on a transparent background. */
function screenshot(html, png) {
  const page = pathToFileURL(html).href;
  const dom = execFileSync(
    CHROME,
    ["--headless=new", "--disable-gpu", "--window-size=3000,3000", "--dump-dom", page],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  const size = /data-size="(\d+)x(\d+)"/.exec(dom);
  if (!size) throw new Error(`could not measure ${html}`);
  execFileSync(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=2",
      "--default-background-color=00000000",
      `--window-size=${size[1]},${size[2]}`,
      `--screenshot=${png}`,
      page,
    ],
    { stdio: "ignore" },
  );
}

// ── commands ──

function check() {
  const hashes = readHashes();
  const stale = Object.keys(SHOTS).filter((name) => hashes[name] !== hashOf(blocksOf(name)));
  const unknown = Object.keys(hashes).filter((name) => !(name in SHOTS));
  if (stale.length === 0 && unknown.length === 0) {
    console.log(`✔ ${Object.keys(SHOTS).length} screenshots match the terminal output`);
    return 0;
  }
  for (const name of stale)
    console.error(`✖ media/${name}.png is stale: its terminal output changed`);
  for (const name of unknown) console.error(`✖ media/shots.json lists ${name}, not in SHOTS`);
  console.error(`\nRe-take them on macOS with Chrome: pnpm shots ${stale.join(" ")}`);
  return 1;
}

function render(names) {
  const wanted = names.length > 0 ? names : Object.keys(SHOTS);
  const bad = wanted.filter((name) => !(name in SHOTS));
  if (bad.length > 0) {
    console.error(`unknown shot(s): ${bad.join(", ")}. Known: ${Object.keys(SHOTS).join(", ")}`);
    return 1;
  }
  if (!existsSync(CHROME)) {
    console.error(`Chrome not found at ${CHROME}. Set CHROME to the browser binary.`);
    return 1;
  }
  const hashes = readHashes();
  const work = mkdtempSync(path.join(tmpdir(), "cc-spend-shots-"));
  try {
    for (const name of wanted) {
      const blocks = blocksOf(name);
      const html = path.join(work, `${name}.html`);
      writeFileSync(html, windowHtml(SHOTS[name].title, blocks));
      screenshot(html, path.join(ROOT, "media", `${name}.png`));
      hashes[name] = hashOf(blocks);
      console.log(`✔ media/${name}.png`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const ordered = Object.fromEntries(
    Object.keys(SHOTS)
      .filter((name) => name in hashes)
      .map((name) => [name, hashes[name]]),
  );
  writeFileSync(HASHES, `${JSON.stringify(ordered, null, 2)}\n`);
  return 0;
}

const [command, ...args] = process.argv.slice(2);

if (command === "_blocks") {
  const shot = SHOTS[args[0]];
  const fixture = await import(
    pathToFileURL(path.join(ROOT, "scripts", "shots", shot.module)).href
  );
  process.stdout.write(JSON.stringify(await fixture[shot.fn](DIST)));
} else if (command === "check") {
  process.exitCode = check();
} else if (command === "render") {
  process.exitCode = render(args);
} else {
  console.error("usage: shots.mjs check | render [name…]");
  process.exitCode = 2;
}
