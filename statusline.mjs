#!/usr/bin/env node
// Claude Code statusLine command: maps the session JSON on stdin to CC_* env
// vars and renders them with Starship using ./statusline.toml. Segments and
// formats follow the cc-memento oh-my-posh bar, with Nerd Font icons.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

// Nerd Font icons, as escapes: raw glyphs are invisible and get lost in edits.
const ICON = {
  version: "\uf02b",
  account: "\uf007",
  branch: "\ue725",
  worktree: "\u{f0645}",
  diff: "\uf440",
  clock: "\uf017",
  context: "\uf1c0",
  warm: "\uf06d",
  cold: "\uf2dc",
  fiveHour: "\uf252",
  sevenDay: "\uf073",
  warning: "\uf071",
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

// Branch name and its " ↑1 ↓2 *" marks from `git status`; "─" outside a repository.
function gitStatus(dir) {
  const git = (...args) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1500 });
  try {
    const [head = "", ...changes] = git("status", "--branch", "--porcelain", "--untracked-files=no").split("\n");
    let name = head.replace(/^## (No commits yet on )?/, "").split(/\.\.\.| /)[0];
    if (name === "HEAD") name = git("rev-parse", "--short", "HEAD").trim();
    const ahead = head.match(/ahead (\d+)/);
    const behind = head.match(/behind (\d+)/);
    const marks = [ahead && `↑${ahead[1]}`, behind && `↓${behind[1]}`, changes.some((l) => l.trim()) && "*"];
    return { name, marks: marks.filter(Boolean).map((m) => ` ${m}`).join("") };
  } catch {
    return { name: "─", marks: "" };
  }
}

const truncate = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// In a worktree, its name replaces the branch; the branch is added only when it
// isn't the one Claude Code derived from the name ("worktree-<name>").
function branchLabel(j, git, max) {
  const worktree = j.worktree?.name || j.workspace?.git_worktree;
  const branch = `${ICON.branch} ${truncate(git.name, max)}`;
  if (!worktree) return `${branch}${git.marks}`;
  const derived = git.name === "─" || [worktree, `worktree-${worktree}`, j.worktree?.branch].includes(git.name);
  return `${ICON.worktree} ${truncate(worktree, max)}${derived ? "" : ` ${branch}`}${git.marks}`;
}

// Minutes until the prompt cache goes cold (amber from 5), or "cold" once it has.
function cacheTimer(cache) {
  if (!cache?.caching_observed) return null;
  const left = cache.warm && cache.expires_at ? Math.floor((cache.expires_at * 1000 - Date.now()) / 60e3) : -1;
  if (left < 0) return `${ICON.cold} ${AMBER}cold${TEXT}`;
  const label = left < 1 ? "<1m" : `${left}m`;
  return `${ICON.warm} ${left <= 5 ? `${AMBER}${label}${TEXT}` : label}`;
}

// The directory as Starship's directory module shows it, for width estimates.
function directoryLabel(dir) {
  const home = os.homedir();
  const shown = dir === home || dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir;
  const parts = shown.split("/").filter(Boolean);
  return ` ${parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : shown}`;
}

const visibleLength = (s) => [...s.replace(/\x1b\[[0-9;]*m/g, "")].length;

// Start cap, then each segment with a space on both sides and its arrow or end cap.
const lineWidth = (segments) => 1 + segments.reduce((w, s) => w + visibleLength(s) + 3, 0);

// Applies `steps` (partial segment maps: a shorter text, or null to drop) in
// order until the line fits in `budget` columns.
function fit(segments, steps, budget) {
  let current = segments;
  for (const step of steps) {
    if (lineWidth(Object.values(current).filter(Boolean)) <= budget) break;
    current = { ...current, ...step };
  }
  return Object.values(current).filter(Boolean);
}

// Packs the visible segments into CC_L<line>_<slot> and marks the last slot.
function slots(line, segments) {
  const vars = Object.fromEntries(segments.map((s, i) => [`CC_L${line}_${i + 1}`, s]));
  vars[`CC_L${line}_END${segments.length}`] = "1";
  return vars;
}

// Saves 5h/7d usage for the shell prompt: "<5h reset> <5h %> <7d reset> <7d %>".
function saveUsage(fiveHour, sevenDay) {
  if (fiveHour?.used_percentage == null || sevenDay?.used_percentage == null) return;
  const dir = process.env.STATUSLINE_CACHE_DIR || path.join(os.homedir(), ".cache", "starship-statusline");
  const line = [fiveHour, sevenDay].map((w) => `${w.resets_at ?? 0} ${Math.round(w.used_percentage)}`).join(" ");
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `usage.${process.pid}`);
    writeFileSync(tmp, `${line}\n`);
    renameSync(tmp, path.join(dir, "usage"));
  } catch {
    // The shell prompt just keeps the previous numbers.
  }
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
  const git = gitStatus(dir);
  // Claude Code sets COLUMNS; keep a margin for the bar's own indent.
  const budget = (Number(process.env.COLUMNS) || Infinity) - 2;
  saveUsage(fiveHour, sevenDay);

  const diff = `${ICON.diff} +${cost.total_lines_added ?? 0}/−${cost.total_lines_removed ?? 0}`;
  const fiveHourUsage = fiveHour?.used_percentage != null &&
    `${ICON.fiveHour} 5h ${fiveHour.used_percentage >= 100 ? `${ICON.warning} Extra` : percent(fiveHour.used_percentage)}`;
  const sevenDayUsage = sevenDay?.used_percentage != null && `${ICON.sevenDay} 7d ${percent(sevenDay.used_percentage)}`;

  // Each line lists its segments, then what to shorten or drop first when narrow.
  const line1 = fit({
    model: `${accent("✻")} ${cleanModelName(j.model?.display_name, j.model?.id)}`,
    effort: effort ? `${accent(effort.icon)} ${effort.label}` : j.effort?.level,
    version: j.version && `${ICON.version} v${j.version}`,
    account: email && `${ICON.account} ${email}`,
  }, [{ account: null }, { version: null }, { effort: null }], budget);

  const line2 = fit({
    directory: directoryLabel(dir),
    branch: branchLabel(j, git, 24),
    diff: cost.total_duration_ms > 0 ? `${diff} · ${ICON.clock} ${formatDuration(cost.total_duration_ms)}` : diff,
  }, [{ diff }, { branch: branchLabel(j, git, 12) }, { diff: null }], budget).slice(1);

  const line3 = fit({
    context: `${ICON.context} CTX ${percent(ctx.used_percentage)} / ${formatTokens(ctx.total_input_tokens ?? 0)} ($${(cost.total_cost_usd ?? 0).toFixed(2)})`,
    cache: cacheTimer(j.prompt_cache),
    fiveHour: fiveHourUsage && fiveHourUsage + formatReset(fiveHour.resets_at),
    sevenDay: sevenDayUsage && sevenDayUsage + formatReset(sevenDay.resets_at),
  }, [{ sevenDay: sevenDayUsage }, { fiveHour: fiveHourUsage }, { sevenDay: null }, { cache: null }, { fiveHour: null }], budget);

  return {
    dir,
    vars: {
      ...slots(1, line1),
      // Line 2's first slot is Starship's own directory module.
      ...Object.fromEntries(line2.map((s, i) => [`CC_L2_${i + 2}`, s])),
      [`CC_L2_END${line2.length + 1}`]: "1",
      ...slots(3, line3),
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
