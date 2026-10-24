// Drawing pieces for the control panel, colored by the look under the cursor:
// pills with rounded caps, rounded boxes, swatches, keycaps, the grid of looks.
import { bg, chroma, contrast, fg, rgb } from "./color.ts";
import type { Preset } from "./presets.ts";

const ESC = "\x1b";
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const CAP_L = "\u{e0b6}", CAP_R = "\u{e0b4}", ARROW = "\u{e0b0}";
/** What the panel assumes it is drawn on: a dark terminal. */
const TERMINAL = "#1d2021";
const DARK_TEXT = "#111111", LIGHT_TEXT = "#ffffff";

export interface Theme {
  /** Titles, the cursor, the active tab: the look's most vivid readable color. */
  accent: string;
  /** Section headings and marks: a second, different hue. */
  second: string;
  /** Text drawn on an accent-filled pill. */
  onAccent: string;
  text: string;
  dim: string;
  border: string;
  keycap: string;
}

// deno-lint-ignore no-control-regex -- ANSI color codes
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Columns a string takes on screen (color codes take none). */
export const visibleWidth = (s: string) => [...s.replace(ANSI, "")].length;

/** Cuts `s` to `width` visible columns, ending in "…", keeping its colors. */
export function clip(s: string, width: number): string {
  if (visibleWidth(s) <= width) return s;
  let out = "", used = 0;
  // deno-lint-ignore no-control-regex -- splits on ANSI color codes
  for (const part of s.split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
    if (part.startsWith(ESC)) {
      out += part;
      continue;
    }
    for (const ch of part) {
      if (used === width - 1) return `${out}…${RESET}`;
      out += ch;
      used++;
    }
  }
  return out;
}

const mix = (a: string, b: string, t: number) =>
  "#" + rgb(a).map((x, i) => Math.round(x + (rgb(b)[i] - x) * t).toString(16).padStart(2, "0")).join("");

function hue(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => c / 255);
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

/** The panel's colors for a look: its most vivid colors that read well on a dark terminal. */
export function themeOf(p: Preset): Theme {
  const all = [
    p.bar.accent,
    ...p.shell.segments.flatMap((s) => [s.bg, s.fg]),
    ...p.bar.lines.flat().flatMap((s) => [s.bg, s.fg]),
  ];
  const readable = [...new Set(all)].filter((c) => contrast(c, TERMINAL) >= 3).sort((a, b) =>
    chroma(b) - chroma(a)
  );
  const accent = readable[0] ?? "#d78770";
  const far = (c: string) =>
    Math.min(Math.abs(hue(c) - hue(accent)), 360 - Math.abs(hue(c) - hue(accent))) >= 40;
  const second = readable.find((c) => c !== accent && far(c) && chroma(c) > 40) ?? readable[1] ?? LIGHT_TEXT;
  const onAccent = contrast(DARK_TEXT, accent) >= contrast(LIGHT_TEXT, accent) ? DARK_TEXT : LIGHT_TEXT;
  return {
    accent,
    second,
    onAccent,
    text: "#e6e1d6",
    dim: "#9a958c",
    border: mix(accent, TERMINAL, 0.6),
    keycap: mix(accent, TERMINAL, 0.78),
  };
}

export const paint = (color: string, s: string) => `${fg(color)}${s}${RESET}`;

/** Text on a filled background with rounded ends. */
export function pill(text: string, fill: string, ink: string, bold = false): string {
  return `${fg(fill)}${CAP_L}${bg(fill)}${fg(ink)}${bold ? BOLD : ""}${text}${RESET}${
    fg(fill)
  }${CAP_R}${RESET}`;
}

/** A pill whose fill blends from one color to another, letter by letter. */
export function gradientPill(text: string, from: string, to: string, ink: string): string {
  const chars = [...text];
  const body = chars.map((c, i) => `${bg(mix(from, to, i / Math.max(1, chars.length - 1)))}${c}`).join("");
  return `${fg(from)}${CAP_L}${fg(ink)}${BOLD}${body}${RESET}${fg(to)}${CAP_R}${RESET}`;
}

/** A look in miniature: each segment's background with a dot in its text color. */
export function swatch(p: Preset): string {
  const segs = p.shell.segments.slice(0, 5);
  let s = `${fg(segs[0].bg)}${CAP_L}`;
  segs.forEach((seg, i) => {
    const next = segs[i + 1];
    s += `${bg(seg.bg)}${fg(seg.fg)} ● ` +
      (next ? `${fg(seg.bg)}${bg(next.bg)}${ARROW}` : `${RESET}${fg(seg.bg)}${CAP_R}`);
  });
  return s + RESET;
}
const SWATCH_WIDTH = 21;

/** A rounded box `width` columns wide; lines too long for it are cut. */
export function box(
  title: string,
  lines: string[],
  o: { width: number; theme: Theme; right?: string },
): string[] {
  const { width, theme } = o;
  const line = (s: string) => paint(theme.border, s);
  const head = `${line("╭─ ")}${fg(theme.accent)}${BOLD}${title}${RESET} `;
  let tail = o.right ? ` ${o.right} ${line("─╮")}` : line("─╮");
  if (visibleWidth(head) + visibleWidth(tail) > width) tail = line("─╮");
  const top = head + line("─".repeat(Math.max(0, width - visibleWidth(head) - visibleWidth(tail)))) + tail;
  const inner = width - 4;
  const body = lines.map((l) => {
    const c = clip(l, inner);
    return `${line("│")} ${c}${" ".repeat(inner - visibleWidth(c))} ${line("│")}`;
  });
  return [top, ...body, line(`╰${"─".repeat(width - 2)}╯`)];
}

const NAME_WIDTH = 13, CELL = NAME_WIDTH + SWATCH_WIDTH + 3;

/** How many columns of looks fit in `width`, and how many rows that makes. */
export function gridShape(count: number, width: number): { columns: number; rows: number } {
  const columns = Math.max(1, Math.min(3, Math.floor(width / CELL)));
  return { columns, rows: Math.ceil(count / columns) };
}

/** All looks at once, column by column: name and swatch; the cursor and the look in use marked. */
export function looksGrid(
  presets: Preset[],
  o: { index: number; inUse?: string; width: number; theme: Theme },
): string[] {
  const { theme } = o;
  const { columns, rows } = gridShape(presets.length, o.width);
  const cell = (i: number) => {
    const p = presets[i];
    const name = i === o.index
      ? `${fg(theme.accent)}${BOLD}▸ ${p.name}${RESET}`
      : `  ${paint(theme.text, p.name)}`;
    const mark = p.id === o.inUse ? ` ${paint(theme.second, "●")}` : "  ";
    return name + " ".repeat(Math.max(1, NAME_WIDTH - visibleWidth(name))) + swatch(p) + mark;
  };
  return Array.from({ length: rows }, (_, r) => {
    let row = "";
    for (let c = 0; c < columns && c * rows + r < presets.length; c++) {
      const text = cell(c * rows + r);
      row += c < columns - 1 ? text + " ".repeat(Math.max(1, CELL - visibleWidth(text))) : text;
    }
    return row;
  });
}

/** Top of every screen: a blank line, the logo and version, then the tabs as chips. */
export function header(
  o: { theme: Theme; screen: "looks" | "components" | "fonts"; version: string; width: number },
) {
  const { theme } = o;
  const logo = gradientPill(" \u{f135} cc-starship ", theme.accent, theme.second, theme.onAccent);
  const tagline = `  ${paint(theme.text, "Claude Code status bar")} ${paint(theme.dim, "+")} ${
    paint(theme.text, "shell prompt")
  }`;
  const version = paint(theme.dim, `v${o.version}`);
  const gap = Math.max(2, o.width - 1 - visibleWidth(logo) - visibleWidth(tagline) - visibleWidth(version));
  const tab = (name: string, on: boolean) =>
    on ? pill(`  ${name}  `, theme.accent, theme.onAccent, true) : paint(theme.dim, `   ${name}   `);
  const looks = o.screen === "looks";
  return [
    "",
    clip(` ${logo}${tagline}${" ".repeat(gap)}${version}`, o.width),
    "",
    ` ${tab("Looks", looks)} ${tab("Components", !looks)}   ${paint(theme.dim, "Tab switches")}`,
    "",
  ];
}

/** Key hints as keycaps: `[["↑↓", "choose"], …]`. */
export function keys(pairs: [string, string][], theme: Theme): string {
  return " " +
    pairs.map(([k, label]) =>
      `${bg(theme.keycap)}${fg(theme.text)}${BOLD} ${k} ${RESET} ${paint(theme.dim, label)}`
    ).join("   ");
}
