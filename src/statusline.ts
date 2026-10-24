// The Claude Code status bar: maps the session JSON to CC_* env vars and renders
// them with `starship prompt` using the generated statusline.toml. Segments and
// formats follow the cc-memento oh-my-posh bar, with Nerd Font icons.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { saveSnapshot } from "./hook.ts";
import { home } from "./paths.ts";
import type { Preset } from "./presets.ts";
import { type Clock, DEFAULT_PREFS, formatWhen, type Language, resolvePrefs } from "./when.ts";

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

export interface BarOptions {
  preset: Preset;
  configPath: string;
  starship: string;
  columns?: number;
  accountEmail?: string;
  usageFile?: string;
  /** Where to save this session's numbers for the usage hook. */
  snapshotFile?: string;
  /** Language and clock for reset times; defaults to the system's. */
  prefs?: { language: Language; clock: Clock };
}

const ESC = "\x1b";
// Placeholders resolved once a segment's slot (and so its colors) is known:
/** back to the segment's text color */
const RESTORE = "\x00";
/** back to the segment's background and text color (after a warning chip) */
const RESTORE_ALL = "\x01";
/** the preset's accent color, or the segment's text color where the accent is hard to see */
const ACCENT = "\x02";
const rgb = (hex: string) => hex.match(/\w\w/g)!.map((h) => parseInt(h, 16));
const fg = (hex: string) => `${ESC}[38;2;${rgb(hex).join(";")}m`;
const bg = (hex: string) => `${ESC}[48;2;${rgb(hex).join(";")}m`;

/** WCAG contrast ratio between two colors. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, b] = rgb(hex).map((c) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Nerd Font icons, as escapes: raw glyphs are invisible and get lost in edits.
const ICON = {
  folder: "\uf07b",
  version: "\uf02b",
  account: "\uf007",
  branch: "\ue725",
  worktree: "\u{f0645}",
  diff: "\uf440",
  clock: "\uf017",
  context: "\uf1c0",
  fiveHour: "\uf252",
  sevenDay: "\uf073",
  warning: "\uf071",
};

const EFFORT: Record<string, { icon: string; label: string }> = {
  low: { icon: "○", label: "Low" },
  medium: { icon: "◐", label: "Medium" },
  high: { icon: "●", label: "High" },
  xhigh: { icon: "◎", label: "xHigh" },
  max: { icon: "◆", label: "Max" },
  ultracode: { icon: "✦", label: "Ultracode" },
};

function cleanModelName(displayName?: string, id?: string): string {
  if (displayName?.trim()) return displayName.replace(/\s*\([^)]*\)/g, "").replace(/^claude\s+/i, "").trim();
  if (!id) return "Claude";
  const [family = "", ...ver] = id.replace(/\[1m\]$|-1m$/i, "").replace(/^claude-/i, "").replace(
    /-\d{6,}$/,
    "",
  )
    .split("-");
  const name = family ? family[0].toUpperCase() + family.slice(1) : "";
  return ver.length ? `${name} ${ver.join(".")}` : name;
}

function formatTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1e3);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

// " · 6 PM", " · Sat 18:00", " · sam. 18 h": see formatWhen.
function formatReset(epochSeconds: number | undefined, prefs: { language: Language; clock: Clock }): string {
  return epochSeconds ? ` · ${formatWhen(new Date(epochSeconds * 1000), new Date(), prefs)}` : "";
}

// From 70% an amber chip, from 90% a red one with ▲: dark bold text on the warning
// color reads on every preset, and the change of shape shows even where the
// segment's own text is already orange.
function percent(value?: number): string {
  const p = Math.round(value ?? 0);
  if (p < 70) return `${p}%`;
  const [color, text] = p >= 90 ? ["#fb4934", `▲${p}%`] : ["#fabd2f", `${p}%`];
  return `${bg(color)}${fg("#1d2021")}${ESC}[1m ${text} ${ESC}[22m${RESTORE_ALL}`;
}

// Branch name and its " ↑1 ↓2 *" marks from `git status`; "─" outside a repository.
function gitStatus(dir: string): { name: string; marks: string } {
  const git = (...args: string[]) => {
    const out = new Deno.Command("git", { args: ["-C", dir, ...args], stdout: "piped", stderr: "null" })
      .outputSync();
    if (!out.success) throw new Error("git failed");
    return new TextDecoder().decode(out.stdout);
  };
  try {
    const [head = "", ...changes] = git("status", "--branch", "--porcelain", "--untracked-files=no").split(
      "\n",
    );
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

/**
 * How many other live worktrees this repo has, read from `.git/worktrees` (no git process:
 * on Windows each one costs ~40 ms). In a linked worktree the main checkout counts too;
 * worktrees whose folder is gone (git's "prunable") don't.
 */
function otherWorktrees(dir: string): number {
  for (let d = dir;; d = dirname(d)) {
    const entry = join(d, ".git");
    let info: Deno.FileInfo;
    try {
      info = Deno.statSync(entry);
    } catch {
      if (dirname(d) === d) return 0;
      continue;
    }
    let common = entry, own = "";
    if (!info.isDirectory) {
      const gitdir = /^gitdir:\s*(.+)$/m.exec(Deno.readTextFileSync(entry))?.[1].trim();
      if (!gitdir) return 0;
      const ownDir = resolve(d, gitdir); // <common>/worktrees/<name>
      own = basename(ownDir);
      common = dirname(dirname(ownDir));
    }
    const main = own && basename(common) === ".git" ? 1 : 0;
    const worktrees = join(common, "worktrees");
    try {
      const live = [...Deno.readDirSync(worktrees)].filter((wt) =>
        wt.name !== own && isLive(join(worktrees, wt.name))
      );
      return main + live.length;
    } catch {
      return main; // no linked worktrees
    }
  }
}

/** A linked worktree's folder still exists (git calls the others "prunable"). */
function isLive(folder: string): boolean {
  try {
    Deno.statSync(resolve(folder, Deno.readTextFileSync(join(folder, "gitdir")).trim()));
    return true;
  } catch {
    return false;
  }
}

const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

// In a worktree, its name replaces the branch; the branch is added only when it
// isn't the one Claude Code derived from the name ("worktree-<name>").
function branchLabel(j: Json, git: { name: string; marks: string }, max: number): string | null {
  const worktree = j.worktree?.name || j.workspace?.git_worktree;
  const branch = `${ICON.branch} ${truncate(git.name, max)}`;
  if (!worktree) return git.name === "─" ? null : `${branch}${git.marks}`;
  const derived = git.name === "─" ||
    [worktree, `worktree-${worktree}`, j.worktree?.branch].includes(git.name);
  return `${ICON.worktree} ${truncate(worktree, max)}${derived ? "" : ` ${branch}`}${git.marks}`;
}

// The directory as Starship's directory module shows it, for width estimates.
function directoryLabel(dir: string): string {
  const h = home().replaceAll("\\", "/");
  const d = dir.replaceAll("\\", "/");
  const shown = d.toLowerCase() === h.toLowerCase() || d.toLowerCase().startsWith(`${h.toLowerCase()}/`)
    ? `~${d.slice(h.length)}`
    : d;
  const parts = shown.split("/").filter(Boolean);
  return `${ICON.folder} ${parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : shown}`;
}

// deno-lint-ignore no-control-regex -- strips ANSI colors and the color placeholders
const visibleLength = (s: string) => [...s.replace(/\x1b\[[0-9;]*m|[\x00-\x02]/g, "")].length;

// Start cap, then each segment with a space on both sides and its arrow or end cap.
const lineWidth = (segments: string[]) => 1 + segments.reduce((w, s) => w + visibleLength(s) + 3, 0);

type Segments = Record<string, string | null | false | undefined>;

// Applies `steps` (a shorter text, or null to drop) in order until the line fits.
function fit(segments: Segments, steps: Segments[], budget: number): string[] {
  let current = segments;
  const visible = (s: Segments) => Object.values(s).filter(Boolean) as string[];
  for (const step of steps) {
    if (lineWidth(visible(current)) <= budget) break;
    current = { ...current, ...step };
  }
  return visible(current);
}

// Saves 5h/7d usage for the shell prompt: "<5h reset> <5h %> <7d reset> <7d %>".
function saveUsage(file: string, fiveHour?: Json, sevenDay?: Json): void {
  if (fiveHour?.used_percentage == null || sevenDay?.used_percentage == null) return;
  const line = [fiveHour, sevenDay].map((w) => `${w.resets_at ?? 0} ${Math.round(w.used_percentage)}`).join(
    " ",
  );
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${Deno.pid}`;
    writeFileSync(tmp, `${line}\n`);
    renameSync(tmp, file);
  } catch {
    // The shell prompt just keeps the previous numbers.
  }
}

/** The CC_* env vars for one render, and the directory to run Starship in. */
export function buildBar(j: Json, opts: BarOptions): { dir: string; vars: Record<string, string> } {
  const dir = j.workspace?.current_dir || j.cwd || home();
  const ctx = j.context_window ?? {};
  const cost = j.cost ?? {};
  const limits = j.rate_limits ?? {};
  const effort = EFFORT[String(j.effort?.level ?? "").toLowerCase()];
  const fiveHour = limits.five_hour;
  const sevenDay = limits.seven_day;
  const git = gitStatus(dir);
  const others = git.name === "─" ? 0 : otherWorktrees(dir);
  const branch = branchLabel(j, git, 24);
  const withOthers = branch && others > 0 ? `${branch} · ${ICON.worktree} ${others} more` : branch;
  // Claude Code sets COLUMNS; keep a margin for the bar's own indent.
  const budget = (opts.columns ?? Infinity) - 2;
  if (opts.usageFile) saveUsage(opts.usageFile, fiveHour, sevenDay);
  if (opts.snapshotFile) saveSnapshot(opts.snapshotFile, j);
  const prefs = opts.prefs ?? resolvePrefs(DEFAULT_PREFS);

  const accent = (s: string) => `${ACCENT}${s}${RESTORE}`;
  const diff = `${ICON.diff} +${cost.total_lines_added ?? 0}/−${cost.total_lines_removed ?? 0}`;
  const fiveHourUsage = fiveHour?.used_percentage != null &&
    `${ICON.fiveHour} 5h ${
      fiveHour.used_percentage >= 100 ? `${ICON.warning} Extra` : percent(fiveHour.used_percentage)
    }`;
  const sevenDayUsage = sevenDay?.used_percentage != null &&
    `${ICON.sevenDay} 7d ${percent(sevenDay.used_percentage)}`;

  // Each line lists its segments, then what to shorten or drop first when narrow.
  const line1 = fit(
    {
      model: `${accent("✻")} ${cleanModelName(j.model?.display_name, j.model?.id)}`,
      effort: effort ? `${accent(effort.icon)} ${effort.label}` : j.effort?.level,
      version: j.version && `${ICON.version} v${j.version}`,
      account: opts.accountEmail && `${ICON.account} ${opts.accountEmail}`,
    },
    [{ account: null }, { version: null }, { effort: null }],
    budget,
  );

  const line2 = fit(
    {
      directory: directoryLabel(dir),
      branch: withOthers,
      diff: cost.total_duration_ms > 0
        ? `${diff} · ${ICON.clock} ${formatDuration(cost.total_duration_ms)}`
        : diff,
    },
    [{ branch }, { diff }, { branch: branchLabel(j, git, 12) }, { diff: null }],
    budget,
  ).slice(1);

  const line3 = fit({
    context: `${ICON.context} CTX ${percent(ctx.used_percentage)} / ${
      formatTokens(ctx.total_input_tokens ?? 0)
    } ($${(cost.total_cost_usd ?? 0).toFixed(2)})`,
    fiveHour: fiveHourUsage && fiveHourUsage + formatReset(fiveHour.resets_at, prefs),
    sevenDay: sevenDayUsage && sevenDayUsage + formatReset(sevenDay.resets_at, prefs),
  }, [{ sevenDay: sevenDayUsage }, { fiveHour: fiveHourUsage }, { sevenDay: null }, {
    fiveHour: null,
  }], budget);

  const vars: Record<string, string> = {};
  // Line 2's first slot is Starship's own directory module.
  const lines: [number, string[], number][] = [[1, line1, 0], [2, line2, 1], [3, line3, 0]];
  for (const [l, segments, offset] of lines) {
    segments.forEach((s, i) => {
      const slot = i + offset;
      const colors = opts.preset.bar.lines[l - 1][slot];
      const accent = contrast(opts.preset.bar.accent, colors.bg) >= 3 ? opts.preset.bar.accent : colors.fg;
      vars[`CC_L${l}_${slot + 1}`] = s
        .replaceAll(ACCENT, fg(accent))
        .replaceAll(RESTORE_ALL, bg(colors.bg) + fg(colors.fg))
        .replaceAll(RESTORE, fg(colors.fg));
    });
    vars[`CC_L${l}_END${segments.length + offset}`] = "1";
  }
  return { dir, vars };
}

/** Renders the bar; falls back to the model name if Starship can't run. */
export function renderBar(j: Json, opts: BarOptions): string {
  const { dir, vars } = buildBar(j, opts);
  let cwd = dir;
  try {
    Deno.statSync(cwd);
  } catch {
    cwd = home();
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(Deno.env.toObject())) if (!k.startsWith("CC_")) env[k] = v;
  Object.assign(env, vars, { PWD: cwd, STARSHIP_SHELL: "", STARSHIP_CONFIG: opts.configPath });
  try {
    const out = new Deno.Command(opts.starship, {
      args: ["prompt"],
      cwd,
      env,
      clearEnv: true,
      stdout: "piped",
      stderr: "null",
    })
      .outputSync();
    if (out.success) return new TextDecoder().decode(out.stdout);
  } catch {
    // fall through
  }
  return `✻ ${cleanModelName(j.model?.display_name, j.model?.id)}`;
}

export function readAccountEmail(file: string): string {
  try {
    const email = JSON.parse(Deno.readTextFileSync(file))?.oauthAccount?.emailAddress;
    return typeof email === "string" ? email : "";
  } catch {
    return "";
  }
}

export { join };
