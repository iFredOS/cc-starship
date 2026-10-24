// Where things live on macOS and Windows. HOME / USERPROFILE and
// STARSHIP_STATUSLINE_HOME can be pointed elsewhere, which the tests use.
import { join } from "node:path";

export const isWindows = Deno.build.os === "windows";

export function home(): string {
  const value = Deno.env.get(isWindows ? "USERPROFILE" : "HOME");
  if (!value) throw new Error(`${isWindows ? "USERPROFILE" : "HOME"} is not set`);
  return value;
}

/** Install folder: binary, generated configs, theme choice, manifest, backups, usage. */
export function installDir(): string {
  const override = Deno.env.get("STARSHIP_STATUSLINE_HOME");
  if (override) return override;
  if (isWindows) {
    return join(Deno.env.get("LOCALAPPDATA") ?? join(home(), "AppData", "Local"), "starship-statusline");
  }
  return join(home(), ".local", "share", "starship-statusline");
}

export const binName = isWindows ? "starship-statusline.exe" : "starship-statusline";

export const paths = {
  bin: () => join(installDir(), "bin", binName),
  starshipDownload: () => join(installDir(), "bin", isWindows ? "starship.exe" : "starship"),
  barConfig: () => join(installDir(), "statusline.toml"),
  state: () => join(installDir(), "state.json"),
  manifest: () => join(installDir(), "manifest.json"),
  backups: () => join(installDir(), "backups"),
  usage: () => join(installDir(), "usage"),
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
