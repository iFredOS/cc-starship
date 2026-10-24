// Install, theme switch and uninstall. Install records the prior state of every
// file it touches in manifest.json (never overwritten by a later install), so
// uninstall can put each one back byte for byte.
import { createHash } from "node:crypto";
import { basename, dirname, extname, join } from "node:path";
import { installDir, isWindows, paths, readState, type State } from "./paths.ts";
import { barConfig, findPreset, type Preset, shellConfig } from "./presets.ts";

const MARK_START = "# >>> starship-statusline >>>";
const MARK_END = "# <<< starship-statusline <<<";

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

function statusLineCommand(bin: string): string {
  // Quoted for paths with spaces; forward slashes work in every Windows shell.
  return `${JSON.stringify(bin.replaceAll("\\", "/"))} statusline`;
}

function readSettings(path: string): Record<string, unknown> | null {
  if (!lstat(path)) return null;
  const text = readText(path);
  try {
    return JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    throw new Error(
      `${path} has comments or trailing commas. Claude Code accepts them, but this installer can't ` +
        `safely rewrite that file. Remove them and run the installer again.`,
    );
  }
}

// ── Shell profiles ───────────────────────────────────────────────────────

function shellProfiles(): string[] {
  const override = Deno.env.get("STARSHIP_STATUSLINE_PROFILES");
  if (override !== undefined) return override.split(";").filter(Boolean);
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
    return `Invoke-Expression (& '${starship}' init powershell | Out-String)`;
  }
  const shell = basename(profile).includes("bash") ? "bash" : "zsh";
  const exe = starship === "starship" ? "starship" : `'${starship}'`;
  return `eval "$(${exe} init ${shell})"`;
}

function hookProfile(profile: string, starship: string): ProfileEntry | null {
  const exists = lstat(profile) !== null;
  const text = exists ? readText(profile) : "";
  if (/starship(\.exe)?['"]?\s+init/.test(text)) return null; // already starts Starship
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lead = text && !text.endsWith("\n") ? eol : "";
  const block = lead + [MARK_START, initLine(profile, starship), MARK_END].join(eol) + eol;
  writeText(profile, text + block);
  return { path: profile, created: !exists, block };
}

function unhookProfile(entry: ProfileEntry): string {
  if (!lstat(entry.path)) return `${entry.path}: already gone`;
  const text = readText(entry.path);
  const at = text.lastIndexOf(entry.block);
  if (at < 0) return `${entry.path}: the starship-statusline block was edited; remove it yourself`;
  const rest = text.slice(0, at) + text.slice(at + entry.block.length);
  if (entry.created && rest.replace(/^﻿/, "") === "") {
    Deno.removeSync(entry.path);
    return `${entry.path}: removed (the installer created it)`;
  }
  writeText(entry.path, rest);
  return `${entry.path}: removed the starship-statusline block`;
}

// ── Public operations ────────────────────────────────────────────────────

function preset(id: string): Preset {
  const p = findPreset(id);
  if (!p) throw new Error(`unknown preset "${id}"`);
  return p;
}

function writeConfigs(p: Preset, state: State & { bin: string }, manifest: Manifest): void {
  writeText(paths.barConfig(), barConfig(p));
  writeText(paths.state(), JSON.stringify(state, null, 2) + "\n");
  const entry = manifest.starshipConfig!;
  const now = currentSha(entry.path);
  if (now !== null && now !== entry.written) {
    // Edited by hand since we wrote it: keep a copy before replacing it.
    Deno.copyFileSync(entry.path, join(paths.backups(), `starship.toml.edited-${Date.now()}`));
  }
  entry.written = writeOwned(entry.path, shellConfig(p, state.bin));
}

export async function install(presetId: string, o: InstallOptions): Promise<string[]> {
  const p = preset(presetId);
  const settingsPath = paths.claudeSettings();
  const settings = readSettings(settingsPath); // throws before anything is written
  const report: string[] = [];

  const manifest = readManifest() ?? { version: 1, installedAt: new Date().toISOString(), profiles: [] };
  Deno.mkdirSync(paths.backups(), { recursive: true });

  if (o.copySelf && Deno.execPath() !== o.bin) {
    Deno.mkdirSync(dirname(o.bin), { recursive: true });
    Deno.copyFileSync(Deno.execPath(), o.bin);
    if (!isWindows) Deno.chmodSync(o.bin, 0o755);
    report.push(`installed ${o.bin}`);
  }

  const starshipPath = paths.starshipConfig();
  manifest.starshipConfig ??= {
    path: starshipPath,
    prior: recordPrior(starshipPath, "starship.toml"),
    written: "",
  };
  writeConfigs(p, { theme: p.id, starship: o.starship, bin: o.bin }, manifest);
  report.push(`${starshipPath}: ${p.name} shell prompt`);

  if (!manifest.settings) {
    manifest.settings = {
      path: settingsPath,
      prior: recordPrior(settingsPath, "settings.json"),
      written: "",
      hadStatusLine: settings !== null && "statusLine" in settings,
      priorStatusLine: settings?.statusLine ?? null,
    };
  }
  const data = settings ?? {};
  data.statusLine = { type: "command", command: statusLineCommand(o.bin), padding: 0, refreshInterval: 60 };
  manifest.settings.written = writeOwned(settingsPath, JSON.stringify(data, null, 2) + "\n");
  report.push(`${settingsPath}: statusLine runs ${o.bin}`);

  for (const profile of shellProfiles()) {
    if (manifest.profiles.some((e) => e.path === profile)) continue;
    const entry = hookProfile(profile, o.starship);
    if (entry) {
      manifest.profiles.push(entry);
      report.push(`${profile}: added Starship start-up`);
    } else {
      report.push(`${profile}: already starts Starship, left as is`);
    }
  }

  saveManifest(manifest);
  // A later Claude Code session or shell picks everything up; nothing to restart now.
  return await Promise.resolve(report);
}

export async function setTheme(presetId: string): Promise<void> {
  const p = preset(presetId);
  const state = readState() as (State & { bin: string }) | null;
  const manifest = readManifest();
  if (!state || !manifest?.starshipConfig) throw new Error("not installed yet: run install first");
  writeConfigs(p, { ...state, theme: p.id }, manifest);
  saveManifest(manifest);
  await Promise.resolve();
}

export async function uninstall(): Promise<string[]> {
  const manifest = readManifest();
  if (!manifest) throw new Error(`nothing to uninstall: no manifest in ${installDir()}`);
  const report: string[] = [];

  const sc = manifest.starshipConfig;
  if (sc) {
    if (currentSha(sc.path) !== null && currentSha(sc.path) !== sc.written) {
      const kept = `${sc.path}.edited-${Date.now()}`;
      Deno.copyFileSync(sc.path, kept);
      report.push(`${sc.path}: you had edited it; your version is saved as ${kept}`);
    }
    restorePrior(sc.path, sc.prior);
    report.push(`${sc.path}: restored`);
  }

  const st = manifest.settings;
  if (st) {
    if (currentSha(st.path) === st.written || !lstat(st.path)) {
      restorePrior(st.path, st.prior);
      report.push(`${st.path}: restored`);
    } else {
      // Edited since install: keep the edits, put back only the statusLine.
      const data = readSettings(st.path) ?? {};
      if (st.hadStatusLine) data.statusLine = st.priorStatusLine;
      else delete data.statusLine;
      writeText(st.path, JSON.stringify(data, null, 2) + "\n");
      report.push(`${st.path}: statusLine restored, your other changes kept`);
    }
  }

  for (const entry of manifest.profiles) report.push(unhookProfile(entry));

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
  const script = join(Deno.env.get("TEMP") ?? dir, `starship-statusline-cleanup-${Deno.pid}.cmd`);
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
