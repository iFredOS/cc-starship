// Where things live on macOS and Windows. HOME / USERPROFILE and
// CC_STARSHIP_HOME can be pointed elsewhere, which the tests use.
import { createHash } from "node:crypto";
import { join, posix, win32 } from "node:path";

export const isWindows = Deno.build.os === "windows";

export function home(): string {
  const value = Deno.env.get(isWindows ? "USERPROFILE" : "HOME");
  if (!value) throw new Error(`${isWindows ? "USERPROFILE" : "HOME"} is not set`);
  return value;
}

/** Install folder: binary, generated configs, theme choice, manifest, backups, usage. */
export function installDir(): string {
  const override = Deno.env.get("CC_STARSHIP_HOME");
  if (override) return override;
  if (isWindows) {
    return join(Deno.env.get("LOCALAPPDATA") ?? join(home(), "AppData", "Local"), "cc-starship");
  }
  return join(home(), ".local", "share", "cc-starship");
}

/** Where installs made under the old name (starship-statusline) live. */
export function legacyInstallDir(): string {
  if (isWindows) {
    return join(Deno.env.get("LOCALAPPDATA") ?? join(home(), "AppData", "Local"), "starship-statusline");
  }
  return join(home(), ".local", "share", "starship-statusline");
}

export const binName = isWindows ? "cc-starship.exe" : "cc-starship";

export const paths = {
  bin: () => join(installDir(), "bin", binName),
  starshipDownload: () => join(installDir(), "bin", isWindows ? "starship.exe" : "starship"),
  barConfig: () => join(installDir(), "statusline.toml"),
  state: () => join(installDir(), "state.json"),
  manifest: () => join(installDir(), "manifest.json"),
  backups: () => join(installDir(), "backups"),
  /** This account's 5h/7d usage (see usageFile): Claude Code runs the bar with its CLAUDE_CONFIG_DIR. */
  usage: () => usageFile(installDir(), Deno.env.get("CLAUDE_CONFIG_DIR"), home()),
  /** Per-session snapshots of the bar, read by the usage hook. */
  sessions: () => join(installDir(), "sessions"),
  /** The last folder a person cd'd into (shell memory). */
  lastdir: () => join(installDir(), "lastdir"),
  /** The last daily check for a newer cc-starship. */
  update: () => join(installDir(), "update.json"),
  /** Where Starship reads the shell prompt config. */
  starshipConfig: () => Deno.env.get("STARSHIP_CONFIG") || join(home(), ".config", "starship.toml"),
  claudeDir: () => Deno.env.get("CLAUDE_CONFIG_DIR") || join(home(), ".claude"),
  claudeSettings: () => join(paths.claudeDir(), "settings.json"),
  /** The account file Claude Code keeps next to (not inside) ~/.claude. */
  claudeAccount: () => {
    const dir = Deno.env.get("CLAUDE_CONFIG_DIR");
    return dir ? join(dir, ".claude.json") : join(home(), ".claude.json");
  },
};

/**
 * The account a Claude config dir belongs to: "main" for the stock ~/.claude (or none set), <name> for
 * ~/.claude-<name> (the names cca gives its profiles), else the first 8 hex of the path's sha256.
 */
export function accountName(
  configDir: string | undefined,
  homeDir: string,
  r: PathRules = HOST_RULES,
): string {
  if (!configDir || isStockAccount(configDir, homeDir, r)) return "main";
  const dir = r.path.normalize(configDir).replace(/[\\/]+$/, "");
  const name = r.path.basename(dir);
  const inHome = folderKey(r.path.dirname(dir), r) === folderKey(homeDir, r);
  if (inHome && name.startsWith(".claude-") && name.length > ".claude-".length) {
    return name.slice(".claude-".length);
  }
  return createHash("sha256").update(folderKey(configDir, r)).digest("hex").slice(0, 8);
}

/**
 * Where an account's 5h/7d usage is saved. Limits are per account, so each gets its own file; with one shared
 * file the last account to draw its bar overwrote the others. Main keeps the original name, "usage".
 */
export function usageFile(
  dir: string,
  configDir: string | undefined,
  homeDir: string,
  r: PathRules = HOST_RULES,
): string {
  // Asked of the folder, not the name: a profile called ~/.claude-main is "main" too.
  return join(
    dir,
    isStockAccount(configDir, homeDir, r) ? "usage" : `usage-${accountName(configDir, homeDir, r)}`,
  );
}

/**
 * The usage file the shell prompt shows. The prompt's shell rarely has Claude Code's CLAUDE_CONFIG_DIR, so for
 * someone who only uses a profile its own file never exists: then the most recently written account's file (what
 * 1.1 showed). Only when its own is missing: someone with main and a profile keeps seeing main's numbers.
 */
export function promptUsageFile(dir: string, configDir: string | undefined, homeDir: string): string {
  const own = usageFile(dir, configDir, homeDir);
  try {
    Deno.statSync(own);
    return own;
  } catch {
    // fall through to the newest account's file
  }
  let newest: { path: string; at: number } | null = null;
  try {
    for (const e of Deno.readDirSync(dir)) {
      if (!e.isFile || !/^usage(-.+)?$/.test(e.name)) continue;
      const path = join(dir, e.name);
      const at = Deno.statSync(path).mtime?.getTime() ?? 0;
      if (!newest || at > newest.at) newest = { path, at };
    }
  } catch {
    // no install folder yet
  }
  return newest?.path ?? own;
}

/** No CLAUDE_CONFIG_DIR, or the stock ~/.claude. */
function isStockAccount(configDir: string | undefined, homeDir: string, r: PathRules = HOST_RULES): boolean {
  return !configDir || folderKey(configDir, r) === folderKey(r.path.join(homeDir, ".claude"), r);
}

/** How paths are spelled and compared: this system's by default; the tests also use Windows' on a Mac. */
export interface PathRules {
  path: typeof posix;
  /** The disk ignores case (APFS and NTFS by default). */
  caseless: boolean;
}

const HOST_RULES: PathRules = {
  path: isWindows ? win32 : posix,
  caseless: isWindows || Deno.build.os === "darwin",
};

/** A folder as one comparable key: separators, `.`, doubled and trailing ones folded; case too where ignored. */
function folderKey(dir: string, r: PathRules): string {
  const key = r.path.normalize(dir).replace(/[\\/]+$/, "");
  return r.caseless ? key.toLowerCase() : key;
}

export interface State {
  theme: string;
  /** The starship executable the bar runs. */
  starship: string;
}

export function readState(): State | null {
  try {
    return JSON.parse(Deno.readTextFileSync(paths.state()));
  } catch {
    return null;
  }
}
