// Install, theme switch and uninstall. Install records the prior state of every
// file it touches in manifest.json (never overwritten by a later install), so
// uninstall can put each one back byte for byte.
import { createHash } from "node:crypto";
import { basename, dirname, extname, join, resolve } from "node:path";
import { installDir, isWindows, legacyInstallDir, paths, readState, type State } from "./paths.ts";
import { memoryBlock, promptOffBlock, psQuote, zshQuote } from "./memory.ts";
import {
  applyWindowsTerminal,
  GHOSTTY_LINES,
  restoreWindowsTerminal,
  TERMINAL_FONT,
  TERMINAL_SIZE,
  terminalFiles,
  type WindowsTerminalPrior,
} from "./terminal.ts";
import { barConfig, findPreset, type Preset, shellConfig } from "./presets.ts";
import { DEFAULT_PREFS, type Prefs } from "./when.ts";

const MARK_START = "# >>> cc-starship >>>";
const MARK_END = "# <<< cc-starship <<<";
const MEMORY_START = "# >>> cc-starship memory >>>";
const MEMORY_END = "# <<< cc-starship memory <<<";
const PROMPT_OFF_START = "# >>> cc-starship prompt off >>>";
const PROMPT_OFF_END = "# <<< cc-starship prompt off <<<";
const TERMINAL_START = "# >>> cc-starship terminal >>>";
const TERMINAL_END = "# <<< cc-starship terminal <<<";

type Prior = { kind: "missing" } | { kind: "file"; backup: string } | { kind: "symlink"; target: string };

interface FileEntry {
  path: string;
  prior: Prior;
  /** sha256 of what we last wrote. */
  written: string;
}

interface SettingsEntry extends FileEntry {
  hadStatusLine: boolean;
  priorStatusLine: unknown;
}

interface ProfileEntry {
  path: string;
  created: boolean;
  /** The exact text appended, removed again on uninstall. */
  block: string;
}

interface Manifest {
  version: 1;
  installedAt: string;
  starshipConfig?: FileEntry;
  settings?: SettingsEntry;
  profiles: ProfileEntry[];
  /** Shell memory blocks, one per profile. */
  memory?: ProfileEntry[];
  /** With the shell prompt off: blocks restoring the shell's own prompt where the profile starts Starship. */
  promptOff?: ProfileEntry[];
  /** cmux/Ghostty config blocks. */
  terminal?: ProfileEntry[];
  windowsTerminal?: FileEntry & { fonts: WindowsTerminalPrior };
}

export interface InstallOptions {
  /** The starship executable to use ("starship" when it's on PATH). */
  starship: string;
  /** Where the installed binary lives; Claude Code and the shell prompt run it. */
  bin: string;
  /** Copy the running binary to `bin` (compiled builds only). */
  copySelf?: boolean;
}

// UTF-8 with any BOM kept as U+FEFF, so files are written back exactly.
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const readText = (path: string) => decoder.decode(Deno.readFileSync(path));
const writeText = (path: string, text: string) => {
  Deno.mkdirSync(dirname(path), { recursive: true });
  Deno.writeFileSync(path, new TextEncoder().encode(text));
};
const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");

function lstat(path: string): Deno.FileInfo | null {
  try {
    return Deno.lstatSync(path);
  } catch {
    return null;
  }
}

function readManifest(): Manifest | null {
  try {
    return JSON.parse(Deno.readTextFileSync(paths.manifest()));
  } catch {
    return null;
  }
}

const saveManifest = (m: Manifest) => writeText(paths.manifest(), JSON.stringify(m, null, 2) + "\n");

/** Records what is at `path` now, backing up a regular file. */
function recordPrior(path: string, label: string): Prior {
  const info = lstat(path);
  if (!info) return { kind: "missing" };
  if (info.isSymlink) return { kind: "symlink", target: Deno.readLinkSync(path) };
  const backup = join(paths.backups(), label);
  Deno.mkdirSync(paths.backups(), { recursive: true });
  Deno.copyFileSync(path, backup);
  return { kind: "file", backup };
}

/** Writes a whole file we own; a symlink is replaced, never written through. */
function writeOwned(path: string, text: string): string {
  if (lstat(path)?.isSymlink) Deno.removeSync(path);
  writeText(path, text);
  return sha(text);
}

function restorePrior(path: string, prior: Prior): void {
  if (lstat(path)) Deno.removeSync(path);
  if (prior.kind === "file") {
    Deno.mkdirSync(dirname(path), { recursive: true });
    Deno.copyFileSync(prior.backup, path);
  } else if (prior.kind === "symlink") {
    Deno.symlinkSync(prior.target, path);
  }
}

function currentSha(path: string): string | null {
  try {
    return sha(Deno.readFileSync(path));
  } catch {
    return null;
  }
}

// ── Claude Code settings ─────────────────────────────────────────────────

/** The binary as a command word: forward slashes work in every Windows shell, and quotes
 * only when needed (PowerShell, which Claude Code may use for hooks, can't run a quoted path). */
function commandPath(bin: string): string {
  const path = bin.replaceAll("\\", "/");
  return /^[\w/:.-]+$/.test(path) ? path : JSON.stringify(path);
}

const statusLineCommand = (bin: string) => `${commandPath(bin)} statusline`;

function readSettings(path: string): Record<string, unknown> | null {
  if (!lstat(path)) return null;
  const text = readText(path);
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(
      `${path} has comments or trailing commas. Claude Code accepts them, but this installer can't ` +
        `safely rewrite that file. Remove them and run the installer again.`,
    );
  }
}

// ── Shell profiles ───────────────────────────────────────────────────────

/**
 * The shell profiles to set up. Finding PowerShell's means starting each PowerShell (about
 * 0.3 s apiece), so an install saves the list in its state and later switches reuse it.
 */
export function shellProfiles(state?: { profilePaths?: string[] }): string[] {
  const override = Deno.env.get("CC_STARSHIP_PROFILES");
  if (override !== undefined) return override.split(";").filter(Boolean);
  if (state?.profilePaths) return state.profilePaths;
  if (!isWindows) {
    const home = Deno.env.get("HOME")!;
    const profiles = [join(home, ".zshrc")];
    if ((Deno.env.get("SHELL") ?? "").endsWith("bash")) profiles.push(join(home, ".bashrc"));
    return profiles;
  }
  // Ask each installed PowerShell for its own profile path (Documents may be redirected).
  const found: string[] = [];
  for (const exe of ["powershell", "pwsh"]) {
    try {
      const out = new Deno.Command(exe, {
        args: ["-NoProfile", "-Command", "$PROFILE"],
        stdout: "piped",
        stderr: "null",
      })
        .outputSync();
      const path = new TextDecoder().decode(out.stdout).trim();
      if (out.success && path) found.push(path);
    } catch {
      // that PowerShell isn't installed
    }
  }
  return found;
}

function initLine(profile: string, starship: string): string {
  if (extname(profile).toLowerCase() === ".ps1") {
    return `Invoke-Expression (& ${psQuote(starship)} init powershell | Out-String)`;
  }
  const shell = basename(profile).includes("bash") ? "bash" : "zsh";
  const exe = starship === "starship" ? "starship" : zshQuote(starship);
  return `eval "$(${exe} init ${shell})"`;
}

/** Appends `lines` between markers, in the profile's own line endings. */
function appendBlock(
  profile: string,
  lines: string[],
  start: string,
  end: string,
  ours: boolean,
): ProfileEntry {
  const exists = lstat(profile) !== null;
  const text = exists ? readText(profile) : "";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lead = text && !text.endsWith("\n") ? eol : "";
  const block = lead + [start, ...lines, end].join(eol) + eol;
  writeText(profile, text + block);
  // A profile the installer created is deleted again once all its blocks are gone.
  return { path: profile, created: !exists || ours, block };
}

function hookProfile(profile: string, starship: string, ours: boolean): ProfileEntry | null {
  const text = lstat(profile) ? readText(profile) : "";
  if (STARTS_STARSHIP.test(text)) return null; // already starts Starship
  return appendBlock(profile, [initLine(profile, starship)], MARK_START, MARK_END, ours);
}

/** Profiles the installer created, by any component. */
const createdByUs = (m: Manifest, path: string) =>
  [...m.profiles, ...(m.memory ?? [])].some((e) => e.path === path && e.created);

/** Removes `entry`'s block; `all` are the other blocks, which may need the line break it carried. */
function unhookProfile(entry: ProfileEntry, all: ProfileEntry[]): string {
  if (!lstat(entry.path)) return `${entry.path}: already gone`;
  const text = readText(entry.path);
  const at = text.lastIndexOf(entry.block);
  if (at < 0) return `${entry.path}: the cc-starship block was edited; remove it yourself`;
  const after = text.slice(at + entry.block.length);
  // A block appended to a profile without a final newline starts with one. If text follows,
  // that newline stays (or the lines would join), and the block after it now owns it.
  const lead = /^\r?\n/.exec(entry.block)?.[0] ?? "";
  const keep = lead && after ? lead : "";
  const next = keep && all.find((e) => e !== entry && e.path === entry.path && after.startsWith(e.block));
  if (next) next.block = keep + next.block;
  const rest = text.slice(0, at) + keep + after;
  if (entry.created && rest.replace(/^\uFEFF/, "").trim() === "") {
    Deno.removeSync(entry.path);
    return `${entry.path}: removed (the installer created it)`;
  }
  writeText(entry.path, rest);
  return `${entry.path}: removed the cc-starship block`;
}

const allBlocks = (m: Manifest) => [
  ...m.profiles,
  ...(m.memory ?? []),
  ...(m.promptOff ?? []),
  ...(m.terminal ?? []),
];
const STARTS_STARSHIP = /starship(\.exe)?['"]?\s+init/;

// ── Components ───────────────────────────────────────────────────────────

/** What can be switched on and off. `usage` needs `shell`; `usage` and `hook` need `bar` for data. */
export interface Components {
  bar: boolean;
  shell: boolean;
  usage: boolean;
  /** Claude Code gets the bar's usage numbers with every prompt. */
  hook: boolean;
  /** New tabs open in the last folder; history keeps one copy of each command. */
  memory: boolean;
  /** cmux, Ghostty and Windows Terminal use the same font, size and keys. */
  terminal: boolean;
}

export const ALL_COMPONENTS: Components = {
  bar: true,
  shell: true,
  usage: true,
  hook: true,
  memory: true,
  terminal: true,
};
/** Parts added after the first release start off for existing installs. */
const NEW_COMPONENTS_OFF = { hook: false, memory: false, terminal: false };

export interface InstalledState extends State {
  bin: string;
  components: Components;
  /** Language and clock for dates in the status bar. */
  prefs: Prefs;
  /** Shell profiles found at install (see shellProfiles). */
  profilePaths?: string[];
}

/** The installed state, or null when not installed. */
export function readInstalled(): InstalledState | null {
  const s = readState() as InstalledState | null;
  return s
    ? {
      ...s,
      components: s.components ? { ...NEW_COMPONENTS_OFF, ...s.components } : ALL_COMPONENTS,
      prefs: s.prefs ?? DEFAULT_PREFS,
    }
    : null;
}

function preset(id: string): Preset {
  const p = findPreset(id);
  if (!p) throw new Error(`unknown preset "${id}"`);
  return p;
}

function addShell(p: Preset, state: InstalledState, manifest: Manifest, report: string[]): void {
  const path = paths.starshipConfig();
  manifest.starshipConfig ??= { path, prior: recordPrior(path, "starship.toml"), written: "" };
  const entry = manifest.starshipConfig;
  const now = currentSha(entry.path);
  if (now !== null && entry.written && now !== entry.written) {
    // Edited by hand since we wrote it: keep a copy before replacing it.
    Deno.copyFileSync(entry.path, join(paths.backups(), `starship.toml.edited-${Date.now()}`));
  }
  entry.written = writeOwned(entry.path, shellConfig(p, state.bin, { usage: state.components.usage }));
  report.push(`${entry.path}: ${p.name} shell prompt`);
  for (const profile of shellProfiles(state)) {
    if (manifest.profiles.some((e) => e.path === profile)) continue;
    const hooked = hookProfile(profile, state.starship, createdByUs(manifest, profile));
    if (hooked) {
      manifest.profiles.push(hooked);
      report.push(`${profile}: added Starship start-up`);
    } else {
      report.push(`${profile}: already starts Starship, left as is`);
    }
  }
}

function removeShell(manifest: Manifest, report: string[]): void {
  const entry = manifest.starshipConfig;
  if (entry) {
    if (currentSha(entry.path) !== null && currentSha(entry.path) !== entry.written) {
      const kept = `${entry.path}.edited-${Date.now()}`;
      Deno.copyFileSync(entry.path, kept);
      report.push(`${entry.path}: you had edited it; your version is saved as ${kept}`);
    }
    restorePrior(entry.path, entry.prior);
    report.push(`${entry.path}: restored`);
    delete manifest.starshipConfig;
  }
  for (const profile of manifest.profiles) report.push(unhookProfile(profile, allBlocks(manifest)));
  manifest.profiles = [];
}

function shellKind(profile: string): "zsh" | "powershell" | null {
  if (extname(profile).toLowerCase() === ".ps1") return "powershell";
  return basename(profile).includes("zsh") ? "zsh" : null;
}

/** Shell prompt off: profiles that still start Starship on their own get the shell's prompt back. */
function addPromptOff(state: InstalledState, manifest: Manifest, report: string[]): void {
  manifest.promptOff ??= [];
  for (const profile of shellProfiles(state)) {
    const kind = shellKind(profile);
    if (!kind || manifest.promptOff.some((e) => e.path === profile)) continue;
    if (!lstat(profile) || !STARTS_STARSHIP.test(readText(profile))) continue;
    const lines = promptOffBlock(kind).trimEnd().split("\n");
    manifest.promptOff.push(appendBlock(profile, lines, PROMPT_OFF_START, PROMPT_OFF_END, false));
    report.push(`${profile}: ${kind === "zsh" ? "zsh" : "PowerShell"}'s own prompt in new tabs`);
  }
}

function removePromptOff(manifest: Manifest, report: string[]): void {
  for (const entry of manifest.promptOff ?? []) report.push(unhookProfile(entry, allBlocks(manifest)));
  delete manifest.promptOff;
}

/**
 * Makes `list` hold one block in `file` with exactly `lines`: kept when it already does,
 * otherwise (a first install, or a block an older version wrote) written anew.
 * Returns false when nothing changed.
 */
function ensureBlock(
  manifest: Manifest,
  list: ProfileEntry[],
  file: string,
  lines: string[],
  [start, end]: [string, string],
): boolean {
  const at = list.findIndex((e) => e.path === file);
  const wanted = [start, ...lines, end].join("\n") + "\n";
  if (at >= 0 && list[at].block.replace(/^\r?\n/, "").replaceAll("\r\n", "\n") === wanted) return false;
  let ours = createdByUs(manifest, file);
  if (at >= 0) {
    ours ||= list[at].created;
    unhookProfile(list[at], allBlocks(manifest));
    list.splice(at, 1);
  }
  list.push(appendBlock(file, lines, start, end, ours));
  return true;
}

function addMemory(state: InstalledState, manifest: Manifest, report: string[]): void {
  manifest.memory ??= [];
  for (const profile of shellProfiles(state)) {
    const kind = shellKind(profile);
    if (!kind) {
      if (!manifest.memory.some((e) => e.path === profile)) {
        report.push(`${profile}: shell memory supports zsh and PowerShell only`);
      }
      continue;
    }
    const lines = memoryBlock(kind, paths.lastdir()).trimEnd().split("\n");
    if (ensureBlock(manifest, manifest.memory, profile, lines, [MEMORY_START, MEMORY_END])) {
      report.push(`${profile}: new tabs open in your last folder; history without duplicates`);
    }
  }
}

function removeMemory(manifest: Manifest, report: string[]): void {
  for (const entry of manifest.memory ?? []) report.push(unhookProfile(entry, allBlocks(manifest)));
  delete manifest.memory;
}

function parseJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readText(path).replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function addTerminal(manifest: Manifest, report: string[]): void {
  manifest.terminal ??= [];
  for (const file of terminalFiles()) {
    if (file.endsWith(".json")) {
      if (manifest.windowsTerminal) {
        // Already set up: only bring the default font up to date (an older version may have
        // used another size); the fonts recorded at install stay as they were.
        const data = parseJson(file) as
          | { profiles?: { defaults?: { font?: Record<string, unknown> } } }
          | null;
        const font = data?.profiles?.defaults?.font;
        if (data && font && (font.face !== TERMINAL_FONT || font.size !== TERMINAL_SIZE)) {
          Object.assign(font, { face: TERMINAL_FONT, size: TERMINAL_SIZE });
          manifest.windowsTerminal.written = writeOwned(file, JSON.stringify(data, null, 4) + "\n");
          report.push(`${file}: ${TERMINAL_FONT} ${TERMINAL_SIZE} for every profile`);
        }
        continue;
      }
      const data = parseJson(file);
      if (!data) {
        report.push(`${file}: has comments, so set the font by hand (${TERMINAL_FONT} ${TERMINAL_SIZE})`);
        continue;
      }
      const prior = recordPrior(file, "windows-terminal-settings.json");
      const fonts = applyWindowsTerminal(data);
      const written = writeOwned(file, JSON.stringify(data, null, 4) + "\n");
      manifest.windowsTerminal = { path: file, prior, written, fonts };
      report.push(`${file}: ${TERMINAL_FONT} ${TERMINAL_SIZE} for every profile`);
    } else if (
      ensureBlock(manifest, manifest.terminal, file, GHOSTTY_LINES, [TERMINAL_START, TERMINAL_END])
    ) {
      report.push(`${file}: ${TERMINAL_FONT} ${TERMINAL_SIZE}, Option key as Alt`);
    }
  }
}

/** JSON with keys in a fixed order, to compare content regardless of layout. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const backupOf = (e: FileEntry) => (e.prior.kind === "file" ? e.prior.backup : "none");

/**
 * Writes `data` back to `entry.path`; when it is exactly what was there before install,
 * the original file comes back byte for byte (or is removed, if there was none).
 */
function putBackJson(entry: FileEntry, data: Record<string, unknown>, indent: number): string {
  const before = entry.prior.kind === "file"
    ? parseJson(entry.prior.backup)
    : entry.prior.kind === "missing"
    ? {}
    : parseJson(resolve(dirname(entry.path), entry.prior.target));
  if (before && canonical(before) === canonical(data)) {
    restorePrior(entry.path, entry.prior);
    return "restored";
  }
  const text = JSON.stringify(data, null, indent) + "\n";
  if (entry.prior.kind === "symlink") {
    // Your link comes back; what changed since install is saved beside it, not written into the dotfile.
    const saved = `${entry.path}.cc-starship-edits.json`;
    writeText(saved, text);
    restorePrior(entry.path, entry.prior);
    return `your link is back; changes made since install are in ${saved}`;
  }
  writeText(entry.path, text);
  return "our changes taken out, yours kept";
}

function removeTerminal(manifest: Manifest, report: string[]): void {
  for (const entry of manifest.terminal ?? []) report.push(unhookProfile(entry, allBlocks(manifest)));
  delete manifest.terminal;
  const wt = manifest.windowsTerminal;
  if (wt) {
    const data = lstat(wt.path) ? parseJson(wt.path) : {};
    if (!data) {
      report.push(
        `${wt.path}: can't be read as JSON any more, so it was left as is (backup: ${backupOf(wt)})`,
      );
    } else {
      restoreWindowsTerminal(data, wt.fonts);
      report.push(`${wt.path}: ${putBackJson(wt, data, 4)}`);
    }
    delete manifest.windowsTerminal;
  }
}

const hookCommand = (bin: string) => `${commandPath(bin)} hook`;

type HookGroup = { matcher?: string; hooks?: { command?: string }[] };

/** Our hook: `<cc-starship> hook`, quoted or not (or under the old starship-statusline name). */
const isOurHook = (h: { command?: string }, bin: string) =>
  h.command === hookCommand(bin) || /(cc-starship|starship-statusline)[^"]*"? hook$/.test(h.command ?? "");

/** `data` with our usage hook added (or taken out), leaving every other hook alone. */
function setUsageHook(data: Record<string, unknown>, bin: string, on: boolean): void {
  const hooks = (data.hooks ?? {}) as Record<string, HookGroup[]>;
  // Take out only our hook; a group keeps any hooks of yours that share it.
  const groups: HookGroup[] = [];
  for (const g of hooks.UserPromptSubmit ?? []) {
    const kept = (g.hooks ?? []).filter((h) => !isOurHook(h, bin));
    if (kept.length === (g.hooks ?? []).length) groups.push(g);
    else if (kept.length) groups.push({ ...g, hooks: kept });
  }
  if (on) groups.push({ hooks: [{ type: "command", command: hookCommand(bin) } as { command: string }] });
  if (groups.length) hooks.UserPromptSubmit = groups;
  else delete hooks.UserPromptSubmit;
  if (Object.keys(hooks).length) data.hooks = hooks;
  else delete data.hooks;
}

/** settings.json holds two parts: the statusLine (bar) and the UserPromptSubmit hook. */
function syncSettings(state: InstalledState, manifest: Manifest, report: string[]): void {
  const { bar, hook } = state.components;
  if (!bar && !hook && !manifest.settings) return; // nothing of ours in settings.json
  const path = paths.claudeSettings();
  const settings = readSettings(path);
  manifest.settings ??= {
    path,
    prior: recordPrior(path, "settings.json"),
    written: "",
    hadStatusLine: settings !== null && "statusLine" in settings,
    priorStatusLine: settings?.statusLine ?? null,
  };
  const data = settings ?? {};
  if (bar) {
    data.statusLine = {
      type: "command",
      command: statusLineCommand(state.bin),
      padding: 0,
      refreshInterval: 60,
    };
  } else {
    // Off means no status bar, not the one set before install (uninstall puts that back).
    delete data.statusLine;
  }
  setUsageHook(data, state.bin, hook);
  if (!bar && !hook && !manifest.settings.hadStatusLine) {
    // Nothing of ours left and nothing to put back later: the file as it was.
    report.push(`${path}: ${putBackJson(manifest.settings, data, 2)}`);
    delete manifest.settings;
    return;
  }
  if (!bar) report.push(`${path}: no status bar in Claude Code`);
  manifest.settings.written = writeOwned(path, JSON.stringify(data, null, 2) + "\n");
  if (bar) report.push(`${path}: statusLine runs ${state.bin}`);
  if (hook) report.push(`${path}: Claude gets your usage (see "Send usage to Claude" for when)`);
}

function removeSettings(manifest: Manifest, report: string[], bin = ""): void {
  const entry = manifest.settings;
  if (!entry) return;
  // Put back only what we set; anything else changed since install (by you, or merged
  // into our later writes) stays.
  const data = readSettings(entry.path) ?? {};
  if (entry.hadStatusLine) data.statusLine = entry.priorStatusLine;
  else delete data.statusLine;
  setUsageHook(data, bin, false);
  report.push(`${entry.path}: ${putBackJson(entry, data, 2)}`);
  delete manifest.settings;
}

/** Brings the files in line with `state`: its preset, and each component on or off. */
function apply(state: InstalledState, manifest: Manifest, report: string[]): void {
  const p = preset(state.theme);
  if (Deno.env.get("CC_STARSHIP_PROFILES") === undefined) state.profilePaths ??= shellProfiles();
  writeText(paths.barConfig(), barConfig(p));
  writeText(paths.state(), JSON.stringify(state, null, 2) + "\n");
  if (state.components.shell) {
    removePromptOff(manifest, report);
    addShell(p, state, manifest, report);
  } else {
    removeShell(manifest, report);
    addPromptOff(state, manifest, report);
  }
  syncSettings(state, manifest, report);
  if (state.components.memory) addMemory(state, manifest, report);
  else removeMemory(manifest, report);
  if (state.components.terminal) addTerminal(manifest, report);
  else removeTerminal(manifest, report);
  saveManifest(manifest);
}

// ── Public operations ────────────────────────────────────────────────────

export async function install(
  presetId: string,
  o: InstallOptions & { components?: Components; prefs?: Prefs },
): Promise<string[]> {
  preset(presetId);
  const legacy = legacyInstallDir();
  if (legacy !== installDir() && lstat(join(legacy, "manifest.json"))) {
    const command = isWindows
      ? `$env:CC_STARSHIP_HOME = '${legacy}'; & '${Deno.execPath()}' uninstall; Remove-Item Env:CC_STARSHIP_HOME`
      : `CC_STARSHIP_HOME='${legacy}' '${Deno.execPath()}' uninstall`;
    throw new Error(
      `an install made under the old name is still in ${legacy}. Remove it first with:\n  ${command}\n` +
        `then install again.`,
    );
  }
  const previous = readInstalled();
  const components = o.components ?? previous?.components ?? ALL_COMPONENTS;
  const prefs = o.prefs ?? previous?.prefs ?? DEFAULT_PREFS;
  if (components.bar || components.hook) readSettings(paths.claudeSettings()); // throws before anything is written
  const report: string[] = [];
  const manifest = readManifest() ?? { version: 1, installedAt: new Date().toISOString(), profiles: [] };
  Deno.mkdirSync(paths.backups(), { recursive: true });

  if (o.copySelf && Deno.execPath() !== o.bin) {
    Deno.mkdirSync(dirname(o.bin), { recursive: true });
    Deno.copyFileSync(Deno.execPath(), o.bin);
    if (!isWindows) Deno.chmodSync(o.bin, 0o755);
    report.push(`installed ${o.bin}`);
  }

  apply({ theme: presetId, starship: o.starship, bin: o.bin, components, prefs }, manifest, report);
  // A later Claude Code session or shell picks everything up; nothing to restart now.
  return await Promise.resolve(report);
}

function installed(): { state: InstalledState; manifest: Manifest } {
  const state = readInstalled();
  const manifest = readManifest();
  if (!state || !manifest) throw new Error("not installed yet: run install first");
  return { state, manifest };
}

export async function setTheme(presetId: string): Promise<string[]> {
  preset(presetId);
  const { state, manifest } = installed();
  const report: string[] = [];
  apply({ ...state, theme: presetId }, manifest, report);
  return await Promise.resolve(report);
}

/** Switches components on or off; each one switched off is restored exactly. */
export async function setComponents(components: Components): Promise<string[]> {
  const { state, manifest } = installed();
  // Throws before anything is written (switching both off still has to edit the file).
  if (components.bar || components.hook || manifest.settings) readSettings(paths.claudeSettings());
  const report: string[] = [];
  apply({ ...state, components }, manifest, report);
  return await Promise.resolve(report);
}

/** Saves the language and clock for dates; only the installed state changes. */
export async function setPrefs(prefs: Prefs): Promise<void> {
  const { state } = installed();
  writeText(paths.state(), JSON.stringify({ ...state, prefs }, null, 2) + "\n");
  await Promise.resolve();
}

export async function uninstall(): Promise<string[]> {
  const manifest = readManifest();
  if (!manifest) throw new Error(`nothing to uninstall: no manifest in ${installDir()}`);
  const report: string[] = [];
  removeTerminal(manifest, report);
  removePromptOff(manifest, report);
  removeMemory(manifest, report);
  removeShell(manifest, report);
  removeSettings(manifest, report, readInstalled()?.bin);
  removeInstallDir();
  report.push(`${installDir()}: removed`);
  return await Promise.resolve(report);
}

/** True when this process is the installed binary (Windows can't delete it while it runs). */
export function runningFromInstallDir(): boolean {
  return Deno.execPath().toLowerCase().startsWith(installDir().toLowerCase());
}

function removeInstallDir(): void {
  const dir = installDir();
  if (!(isWindows && runningFromInstallDir())) {
    Deno.removeSync(dir, { recursive: true });
    return;
  }
  // Windows keeps the running exe locked: remove everything else now, and let a
  // small script delete the folder once we've exited (retrying for up to a minute),
  // then delete itself.
  for (const entry of Deno.readDirSync(dir)) {
    if (entry.name !== "bin") Deno.removeSync(join(dir, entry.name), { recursive: true });
  }
  const script = join(Deno.env.get("TEMP") ?? dir, `cc-starship-cleanup-${Deno.pid}.cmd`);
  Deno.writeTextFileSync(
    script,
    [
      "@echo off",
      "set n=0",
      ":retry",
      `rmdir /s /q "${dir}" 2>nul`,
      `if not exist "${dir}" goto done`,
      "set /a n+=1",
      "if %n% geq 60 goto done",
      "ping -n 2 127.0.0.1 >nul",
      "goto retry",
      ":done",
      'del "%~f0"',
      "",
    ].join("\r\n"),
  );
  // `start /min` gives the script its own console, so closing this window doesn't stop it.
  new Deno.Command("cmd", {
    args: [`/c start "" /min cmd /c "${script}"`],
    windowsRawArguments: true,
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn().unref();
}
