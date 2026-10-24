#!/usr/bin/env node
// Claude Code statusLine command: maps the session JSON on stdin to CC_* env
// vars and renders them with Starship using ./starship.toml. Segments and
// formats follow the cc-memento oh-my-posh bar, with Nerd Font icons.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const CONFIG = path.join(here, "statusline.toml");

// The active theme is the palette selected in statusline.toml (see ./theme).
// Rainbow puts the accent on orange and yellow, so it uses the text color there.
const THEMES = {
  gray: { text: "ebdbb2", accent: "d78770" },
  rainbow: { text: "fbf1c7", accent: "fbf1c7" },
};
const theme = THEMES[readFileSync(CONFIG, "utf8").match(/^palette = '(\w+)'/m)?.[1]] ?? THEMES.gray;

const ESC = "\x1b";
const fg = (hex) => `${ESC}[38;2;${hex.match(/\w\w/g).map((h) => parseInt(h, 16)).join(";")}m`;
const TEXT = fg(theme.text);
const ACCENT = fg(theme.accent);
const AMBER = fg("fabd2f");
const RED = fg("fb4934");
const accent = (s) => `${ACCENT}${s}${TEXT}`;

const ICON = {
  version: "",
  account: "",
  branch: "",
  diff: "",
  clock: "",
  context: "",
  fiveHour: "",
  sevenDay: "",
  warning: "",
};

const EFFORT = {
  low: { icon: "○", label: "Low" },
  medium: { icon: "◐", label: "Medium" },
  high: { icon: "●", label: "High" },
  xhigh: { icon: "◎", label: "xHigh" },
  max: { icon: "◆", label: "Max" },
  ultracode: { icon: "✦", label: "Ultracode" },
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function cleanModelName(displayName, id) {
  if (displayName?.trim()) return displayName.replace(/\s*\([^)]*\)/g, "").replace(/^claude\s+/i, "").trim();
  if (!id) return "Claude";
  const [family = "", ...ver] = id.replace(/\[1m\]$|-1m$/i, "").replace(/^claude-/i, "").replace(/-\d{6,}$/, "").split("-");
  const name = family ? family[0].toUpperCase() + family.slice(1) : "";
  return ver.length ? `${name} ${ver.join(".")}` : name;
}

function accountEmail() {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  const file = dir ? path.join(dir, ".claude.json") : path.join(os.homedir(), ".claude.json");
  const email = readJson(file)?.oauthAccount?.emailAddress;
  return typeof email === "string" ? email : "";
}

function formatTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1e3);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

// Resets within 24 h show "HH:MM"; later ones get the weekday, "Tue HH:MM".
function formatReset(epochSeconds) {
  if (!epochSeconds) return "";
  const d = new Date(epochSeconds * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const day = d.getTime() - Date.now() > 86400e3 ? `${WEEKDAYS[d.getDay()]} ` : "";
  return ` · ${day}${hh}:${mm}`;
}

// Amber from 70%, red from 90%.
function percent(value) {
  const p = Math.round(value ?? 0);
  const color = p >= 90 ? RED : p >= 70 ? AMBER : "";
  return color ? `${color}${p}%${TEXT}` : `${p}%`;
}

// "main ↑1 ↓2 *" from `git status`, "─" outside a repository.
function gitBranch(dir) {
  const git = (...args) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1500 });
  try {
    const [head = "", ...changes] = git("status", "--branch", "--porcelain", "--untracked-files=no").split("\n");
    let branch = head.replace(/^## (No commits yet on )?/, "").split(/\.\.\.| /)[0];
    if (branch === "HEAD") branch = git("rev-parse", "--short", "HEAD").trim();
    const ahead = head.match(/ahead (\d+)/);
    const behind = head.match(/behind (\d+)/);
    return [
      branch,
      ahead && `↑${ahead[1]}`,
      behind && `↓${behind[1]}`,
      changes.some((l) => l.trim()) && "*",
    ].filter(Boolean).join(" ");
  } catch {
    return "─";
  }
}

// Packs the visible segments into CC_L<line>_<slot> and marks the last slot.
function slots(line, segments) {
  const visible = segments.filter(Boolean);
  const vars = Object.fromEntries(visible.map((s, i) => [`CC_L${line}_${i + 1}`, s]));
  vars[`CC_L${line}_END${visible.length}`] = "1";
  return vars;
}

function buildEnv(j) {
  const dir = j.workspace?.current_dir || j.cwd || os.homedir();
  const ctx = j.context_window ?? {};
  const cost = j.cost ?? {};
  const limits = j.rate_limits ?? {};
  const effort = EFFORT[(j.effort?.level ?? "").toLowerCase()];
  const email = accountEmail();
  const fiveHour = limits.five_hour;
  const sevenDay = limits.seven_day;
  const duration = cost.total_duration_ms > 0 ? ` · ${ICON.clock} ${formatDuration(cost.total_duration_ms)}` : "";

  return {
    dir,
    vars: {
      ...slots(1, [
        `${accent("✻")} ${cleanModelName(j.model?.display_name, j.model?.id)}`,
        effort ? `${accent(effort.icon)} ${effort.label}` : j.effort?.level,
        j.version && `${ICON.version} v${j.version}`,
        email && `${ICON.account} ${email}`,
      ]),
      CC_L2_2: `${ICON.branch} ${gitBranch(dir)}`,
      CC_L2_3: `${ICON.diff} +${cost.total_lines_added ?? 0}/−${cost.total_lines_removed ?? 0}${duration}`,
      ...slots(3, [
        `${ICON.context} CTX ${percent(ctx.used_percentage)} / ${formatTokens(ctx.total_input_tokens ?? 0)} ($${(cost.total_cost_usd ?? 0).toFixed(2)})`,
        fiveHour?.used_percentage != null &&
          `${ICON.fiveHour} 5h ${fiveHour.used_percentage >= 100 ? `${ICON.warning} Extra` : percent(fiveHour.used_percentage)}${formatReset(fiveHour.resets_at)}`,
        sevenDay?.used_percentage != null &&
          `${ICON.sevenDay} 7d ${percent(sevenDay.used_percentage)}${formatReset(sevenDay.resets_at)}`,
      ]),
    },
  };
}

const { dir, vars } = buildEnv(readJson(0) ?? {});
const cwd = existsSync(dir) ? dir : os.homedir();
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CC_")));
Object.assign(env, vars, {
  PWD: cwd,
  STARSHIP_SHELL: "",
  STARSHIP_CONFIG: CONFIG,
});

try {
  process.stdout.write(execFileSync("starship", ["prompt"], { cwd, env, encoding: "utf8", timeout: 2000 }));
} catch {
  process.stdout.write(vars.CC_L1_1);
}
