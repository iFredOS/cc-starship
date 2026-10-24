// Color presets: one entry colors both the shell prompt and the status bar.
import { BAR_TEMPLATE, PRESETS, SHELL_TEMPLATE } from "./assets.gen.ts";

export interface Pair {
  bg: string;
  fg: string;
}

export interface Preset {
  id: string;
  name: string;
  source: string;
  bar: { accent: string; lines: Pair[][] };
  shell: { segments: Pair[] };
}

// The prompt symbol's colors, the same for every preset.
const PROMPT_COLORS = {
  color_green: "#98971a",
  color_red: "#cc241d",
  color_purple: "#b16286",
  color_yellow: "#d79921",
};

export const DEFAULT_PRESET = "rainbow";

export function allPresets(): Preset[] {
  return PRESETS;
}

export function findPreset(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

function palette(name: string, colors: Record<string, string>): string {
  const lines = Object.entries(colors).map(([k, v]) => `${k} = '${v}'`);
  return `[palettes.${name}]\n${lines.join("\n")}`;
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`template value missing: ${key}`);
    return values[key];
  });
}

/** Starship config for the shell prompt; `bin` is the installed binary (for usage). */
export function shellConfig(preset: Preset, bin: string): string {
  const colors: Record<string, string> = { ...PROMPT_COLORS };
  preset.shell.segments.forEach((s, i) => {
    colors[`s${i + 1}_bg`] = s.bg;
    colors[`s${i + 1}_fg`] = s.fg;
  });
  // TOML literal string: forward slashes keep Windows paths free of escapes.
  return fill(SHELL_TEMPLATE, {
    THEME: preset.id,
    PALETTE: palette(preset.id, colors),
    BIN: bin.replaceAll("\\", "/"),
  });
}

/** Starship config for the Claude Code status bar. */
export function barConfig(preset: Preset): string {
  const colors: Record<string, string> = {};
  preset.bar.lines.forEach((line, l) =>
    line.forEach((s, i) => {
      colors[`l${l + 1}_${i + 1}`] = s.bg;
      colors[`f${l + 1}_${i + 1}`] = s.fg;
    })
  );
  return fill(BAR_TEMPLATE, { THEME: preset.id, PALETTE: palette(preset.id, colors) });
}
