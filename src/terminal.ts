// Terminal settings: the same font and keys in cmux, Ghostty and Windows Terminal.
import { join } from "node:path";
import { windowsTerminalSettings } from "./fonts.ts";
import { home, isWindows } from "./paths.ts";

export const TERMINAL_FONT = "JetBrainsMono Nerd Font";
export const TERMINAL_SIZE = 15;

/** Appended to cmux/Ghostty configs; `font-family = ""` clears earlier fallbacks first. */
export const GHOSTTY_LINES = [
  'font-family = ""',
  `font-family = "${TERMINAL_FONT}"`,
  `font-size = ${TERMINAL_SIZE}`,
  "macos-option-as-alt = left",
];

const exists = (path: string) => {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
};

/** Config files of the terminals on this machine (.json is Windows Terminal, else Ghostty style). */
export function terminalFiles(): string[] {
  const override = Deno.env.get("STARSHIP_STATUSLINE_TERMINALS");
  if (override !== undefined) return override.split(";").filter(Boolean);
  if (isWindows) {
    const wt = windowsTerminalSettings();
    return wt ? [wt] : [];
  }
  const files: string[] = [];
  const cmux = join(home(), "Library", "Application Support", "com.cmuxterm.app", "config.ghostty");
  if (exists(cmux) || exists("/Applications/cmux.app")) files.push(cmux);
  const ghostty = join(home(), ".config", "ghostty", "config");
  if (exists(ghostty) || exists("/Applications/Ghostty.app")) files.push(ghostty);
  return files;
}

type FontKeys = { font?: Record<string, unknown>; fontFace?: unknown; fontSize?: unknown };
export interface WindowsTerminalPrior {
  defaultsFont?: Record<string, unknown>;
  /** Each profile's font settings before, by guid (or name). */
  profiles: Record<string, FontKeys>;
}

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

const profileKey = (p: Json) => String(p.guid ?? p.name);

function profileList(data: Json): Json[] {
  data.profiles ??= {};
  if (Array.isArray(data.profiles)) data.profiles = { defaults: {}, list: data.profiles };
  data.profiles.defaults ??= {};
  return data.profiles.list ?? [];
}

/** Sets the default font and drops per-profile face and size; returns what was there. */
export function applyWindowsTerminal(data: Json): WindowsTerminalPrior {
  const list = profileList(data);
  const prior: WindowsTerminalPrior = { defaultsFont: data.profiles.defaults.font, profiles: {} };
  data.profiles.defaults.font = { ...data.profiles.defaults.font, face: TERMINAL_FONT, size: TERMINAL_SIZE };
  for (const p of list) {
    const before: FontKeys = {};
    if (p.font) before.font = { ...p.font };
    if ("fontFace" in p) before.fontFace = p.fontFace;
    if ("fontSize" in p) before.fontSize = p.fontSize;
    if (!Object.keys(before).length) continue;
    prior.profiles[profileKey(p)] = before;
    delete p.fontFace;
    delete p.fontSize;
    if (p.font) {
      delete p.font.face;
      delete p.font.size;
      if (!Object.keys(p.font).length) delete p.font;
    }
  }
  return prior;
}

/** Puts back the fonts `applyWindowsTerminal` changed, keeping everything else. */
export function restoreWindowsTerminal(data: Json, prior: WindowsTerminalPrior): void {
  const list = profileList(data);
  if (prior.defaultsFont) data.profiles.defaults.font = prior.defaultsFont;
  else delete data.profiles.defaults.font;
  for (const p of list) {
    const before = prior.profiles[profileKey(p)];
    if (!before) continue;
    delete p.font;
    delete p.fontFace;
    delete p.fontSize;
    Object.assign(p, before);
  }
}
