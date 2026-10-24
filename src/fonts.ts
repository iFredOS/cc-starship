// Nerd Fonts: which are installed, and installing or removing one of a short list
// for the current user. Downloads come from the official nerd-fonts release and
// are checked against its SHA-256.txt.
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { home, installDir, isWindows } from "./paths.ts";
import { fetchBytes } from "./net.ts";

export interface Font {
  id: string;
  /** Family name as terminals list it. */
  family: string;
  /** Release archive name, without extension. */
  archive: string;
  /** File name prefix of the standard (not Mono/Propo) variant. */
  prefix: string;
}

export const FONTS: Font[] = [
  {
    id: "jetbrains",
    family: "JetBrainsMono Nerd Font",
    archive: "JetBrainsMono",
    prefix: "JetBrainsMonoNerdFont-",
  },
  {
    id: "caskaydia",
    family: "CaskaydiaCove Nerd Font",
    archive: "CascadiaCode",
    prefix: "CaskaydiaCoveNerdFont-",
  },
  { id: "firacode", family: "FiraCode Nerd Font", archive: "FiraCode", prefix: "FiraCodeNerdFont-" },
  { id: "hack", family: "Hack Nerd Font", archive: "Hack", prefix: "HackNerdFont-" },
  { id: "meslo", family: "MesloLGS Nerd Font", archive: "Meslo", prefix: "MesloLGSNerdFont-" },
];

const STYLES = ["Regular", "Bold", "Italic", "BoldItalic"];
const RELEASE = "https://github.com/ryanoasis/nerd-fonts/releases/latest/download/";
const REGISTRY = "HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts";

/** Where the user's fonts live, and where installed fonts are looked for. */
export function fontDirs(): { user: string; all: string[] } {
  if (isWindows) {
    const user = join(
      Deno.env.get("LOCALAPPDATA") ?? join(home(), "AppData", "Local"),
      "Microsoft",
      "Windows",
      "Fonts",
    );
    return { user, all: [user, join(Deno.env.get("WINDIR") ?? "C:\\Windows", "Fonts")] };
  }
  const user = join(home(), "Library", "Fonts");
  return { user, all: [user, "/Library/Fonts"] };
}

/** Nerd Font families found in `dirs`, e.g. "JetBrainsMono Nerd Font Mono". */
export function detectNerdFonts(dirs = fontDirs().all): string[] {
  const families = new Set<string>();
  for (const dir of dirs) {
    try {
      for (const entry of Deno.readDirSync(dir)) {
        const m = entry.name.match(/^(.+?)NerdFont(Mono|Propo)?-.*\.(ttf|otf)$/i);
        if (m) families.add(`${m[1]} Nerd Font${m[2] ? ` ${m[2]}` : ""}`);
        // Microsoft ships its own Nerd Font builds: CascadiaCodeNF.ttf, CascadiaMonoNF-Bold.ttf, …
        const ms = entry.name.match(/^(.+?)NF(?:[-A-Z].*)?\.(ttf|otf)$/);
        if (!m && ms) families.add(`${ms[1]} NF`);
      }
    } catch {
      // folder missing
    }
  }
  return [...families].sort();
}

/** One entry per font: Mono/Propo spacing and NL (no ligatures) / DZ variants folded in. */
export function fontFamilies(families: string[]): string[] {
  const base = (f: string) => f.replace(/ (Mono|Propo)$/, "").replace(/(NL|DZ)( Nerd Font| NF)$/, "$2");
  return [...new Set(families.map(base))].sort();
}

/** The standard styles of `font` among `names`, in Regular/Bold/Italic/BoldItalic order. */
export function pickFontFiles(font: Font, names: string[]): string[] {
  return STYLES.map((s) => `${font.prefix}${s}.ttf`).filter((n) => names.includes(n));
}

export function parseChecksum(list: string, file: string): string | null {
  const line = list.split("\n").find((l) => l.trim().endsWith(`  ${file}`));
  return line ? line.trim().split(/\s+/)[0].toLowerCase() : null;
}

/** Downloads and verifies `font`'s archive, unpacks it into `dir`; returns the chosen .ttf files. */
export async function downloadFontFiles(font: Font, dir: string): Promise<string[]> {
  const name = `${font.archive}.zip`;
  const [archive, sums] = await Promise.all([
    fetchBytes(RELEASE + name),
    fetchBytes(RELEASE + "SHA-256.txt"),
  ]);
  const expected = parseChecksum(new TextDecoder().decode(sums), name);
  if (!expected || expected !== createHash("sha256").update(archive).digest("hex")) {
    throw new Error(`checksum mismatch for ${name}`);
  }
  const zip = join(dir, name);
  Deno.writeFileSync(zip, archive);
  const out = new Deno.Command("tar", { args: ["-xf", zip, "-C", dir] }).outputSync();
  if (!out.success) throw new Error(`could not unpack ${name}`);
  const names = [...Deno.readDirSync(dir)].map((e) => e.name);
  const picked = pickFontFiles(font, names);
  if (!picked.length) throw new Error(`${name} has no ${font.prefix}*.ttf files`);
  return picked.map((n) => join(dir, n));
}

interface FontRecord {
  id: string;
  files: string[];
  /** Windows registry value names we added. */
  registry: string[];
}

const recordPath = () => join(installDir(), "fonts.json");

export function installedByUs(): FontRecord[] {
  try {
    return JSON.parse(Deno.readTextFileSync(recordPath()));
  } catch {
    return [];
  }
}

const saveRecords = (records: FontRecord[]) => {
  Deno.mkdirSync(installDir(), { recursive: true });
  Deno.writeTextFileSync(recordPath(), JSON.stringify(records, null, 2) + "\n");
};

/** Installs `font` for the current user; returns a line per step. */
export async function installFont(font: Font): Promise<string[]> {
  const tmp = Deno.makeTempDirSync({ prefix: "cc-starship-font-" });
  try {
    const files = await downloadFontFiles(font, tmp);
    const { user } = fontDirs();
    Deno.mkdirSync(user, { recursive: true });
    const record: FontRecord = { id: font.id, files: [], registry: [] };
    for (const file of files) {
      const dest = join(user, basename(file));
      Deno.copyFileSync(file, dest);
      record.files.push(dest);
      if (isWindows) {
        const value = `${basename(file, ".ttf").replace(/-/, " ")} (TrueType)`;
        const reg = new Deno.Command("reg", {
          args: ["add", REGISTRY, "/v", value, "/t", "REG_SZ", "/d", dest, "/f"],
        })
          .outputSync();
        if (reg.success) record.registry.push(value);
      }
    }
    saveRecords([...installedByUs().filter((r) => r.id !== font.id), record]);
    return [`${font.family}: ${record.files.length} files installed in ${user}`];
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
}

/** Removes a font this app installed. */
export function uninstallFont(id: string): string[] {
  const records = installedByUs();
  const record = records.find((r) => r.id === id);
  if (!record) return [`${id}: not installed by this app, left alone`];
  for (const file of record.files) {
    try {
      Deno.removeSync(file);
    } catch {
      // in use or already gone; Windows frees it after sign-out
    }
  }
  for (const value of record.registry) {
    new Deno.Command("reg", { args: ["delete", REGISTRY, "/v", value, "/f"] }).outputSync();
  }
  saveRecords(records.filter((r) => r.id !== id));
  return [`${FONTS.find((f) => f.id === id)?.family ?? id}: removed`];
}

/** Windows Terminal's settings file, if installed. */
export function windowsTerminalSettings(): string | null {
  const local = Deno.env.get("LOCALAPPDATA");
  if (!local) return null;
  for (
    const pkg of ["Microsoft.WindowsTerminal_8wekyb3d8bbwe", "Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe"]
  ) {
    const path = join(local, "Packages", pkg, "LocalState", "settings.json");
    try {
      Deno.statSync(path);
      return path;
    } catch {
      // not this one
    }
  }
  return null;
}

/**
 * Makes `family` Windows Terminal's default font. Only when settings.json is plain
 * JSON (comments can't be kept by a rewrite); returns the backup path, or null if unchanged.
 */
export function setWindowsTerminalFont(family: string, path: string, backups: string): string | null {
  const text = Deno.readTextFileSync(path);
  let data;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
  Deno.mkdirSync(backups, { recursive: true });
  const backup = join(backups, `windows-terminal-settings-${Date.now()}.json`);
  Deno.writeTextFileSync(backup, text);
  data.profiles ??= {};
  if (Array.isArray(data.profiles)) data.profiles = { defaults: {}, list: data.profiles };
  data.profiles.defaults ??= {};
  data.profiles.defaults.font = { ...data.profiles.defaults.font, face: family };
  Deno.writeTextFileSync(path, JSON.stringify(data, null, 4) + "\n");
  return backup;
}
