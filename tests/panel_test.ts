import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { contrast, rgb } from "../src/color.ts";
import { box, clip, fitView, header, keys, looksGrid, swatch, themeOf, visibleWidth } from "../src/panel.ts";
import { allPresets, findPreset } from "../src/presets.ts";
import { stripAnsi } from "./helpers.ts";

const TERMINAL = "#1d2021"; // a typical dark terminal background
const fusain = findPreset("fusain")!;
const theme = themeOf(fusain);

Deno.test("boxes: rounded corners, the title on top, every line exactly as wide as asked", () => {
  const lines = box("Choose a look", ["short", "a much longer line of content", ""], { width: 40, theme });
  assert(stripAnsi(lines[0]).startsWith("╭─ Choose a look "), lines[0]);
  assert(stripAnsi(lines.at(-1)!).startsWith("╰") && stripAnsi(lines.at(-1)!).endsWith("╯"));
  for (const l of lines) assertEquals(visibleWidth(l), 40, stripAnsi(l));
  for (const l of lines.slice(1, -1)) assert(stripAnsi(l).startsWith("│") && stripAnsi(l).endsWith("│"), l);
});

Deno.test("boxes: content wider than the window is cut, never wraps", () => {
  const long = "\x1b[31m" + "x".repeat(80) + "\x1b[0m";
  const lines = box("t", [long], { width: 30, theme });
  for (const l of lines) assertEquals(visibleWidth(l), 30, stripAnsi(l));
  assertStringIncludes(stripAnsi(lines[1]), "…");
});

Deno.test("clip keeps colors and cuts by what you see", () => {
  const s = "\x1b[31mhello\x1b[0m world";
  assertEquals(stripAnsi(clip(s, 7)), "hello …");
  assertEquals(clip(s, 50), s);
  assertStringIncludes(clip(s, 7), "\x1b[31m");
});

Deno.test("swatch: each segment's background with a dot in its text color", () => {
  for (const p of allPresets()) {
    const s = swatch(p);
    for (const seg of p.shell.segments.slice(0, 5)) {
      assertStringIncludes(s, `48;2;${rgb(seg.bg).join(";")}`, p.id);
      assertStringIncludes(s, `38;2;${rgb(seg.fg).join(";")}`, p.id);
    }
  }
});

Deno.test("theme from a look: readable accents, and the looks don't all look alike", () => {
  const accents = new Set<string>();
  for (const p of allPresets()) {
    const t = themeOf(p);
    assert(contrast(t.accent, TERMINAL) >= 3, `${p.id}: accent ${t.accent} too dark as text`);
    assert(contrast(t.second, TERMINAL) >= 3, `${p.id}: second ${t.second} too dark as text`);
    assert(contrast(t.onAccent, t.accent) >= 4.5, `${p.id}: text on the accent pill`);
    accents.add(t.accent);
  }
  assert(accents.size >= 12, `only ${accents.size} different accents across 15 looks`);
});

Deno.test("looks grid: every look visible at once, the cursor and the one in use marked", () => {
  const presets = allPresets();
  for (const width of [112, 80, 50]) {
    const lines = looksGrid(presets, { index: 2, inUse: "rainbow", width, theme });
    const text = lines.map(stripAnsi).join("\n");
    for (const p of presets) assertStringIncludes(text, p.name, `${width}: ${p.name}`);
    for (const l of lines) assert(visibleWidth(l) <= width, `${width}: ${stripAnsi(l)}`);
    assertStringIncludes(text, `▸ ${presets[2].name}`);
    assert(/Rainbow\s.*●/.test(text), "in use marked");
  }
  assertEquals(looksGrid(presets, { index: 0, width: 112, theme }).length, 5, "three columns of five");
});

Deno.test("header: breathing room, the logo pill, the version, tabs as chips", () => {
  const lines = header({ theme, screen: "looks", version: "1.0.0", width: 100 });
  assertEquals(lines[0], "", "a blank line on top");
  const text = lines.map(stripAnsi).join("\n");
  for (const part of ["cc-starship", "v1.0.0", "Looks", "Components"]) assertStringIncludes(text, part);
  assertStringIncludes(
    lines.join("\n"),
    `48;2;${rgb(theme.accent).join(";")}`,
    "the active tab is a filled chip",
  );
  for (const l of lines) assert(visibleWidth(l) <= 100, stripAnsi(l));
});

Deno.test("key hints: each key as a keycap with its label", () => {
  const lines = keys([["↑↓", "choose"], ["⏎", "use this look"], ["Q", "quit"]], theme, 100);
  assertEquals(lines.length, 1);
  assertEquals(stripAnsi(lines[0]).replace(/\s+/g, " ").trim(), "↑↓ choose ⏎ use this look Q quit");
});

Deno.test("key hints too wide for the window go on a second line, never cut", () => {
  const pairs: [string, string][] = [
    ["↑↓", "choose"],
    ["Space", "on/off or change"],
    ["⏎", "update Starship · pick a font"],
    ["X", "remove Starship"],
    ["Tab", "looks"],
    ["Q", "quit"],
  ];
  for (const width of [119, 80, 50]) {
    const lines = keys(pairs, theme, width);
    for (const l of lines) assert(visibleWidth(l) <= width, `${width}: ${stripAnsi(l)}`);
    const text = lines.map(stripAnsi).join(" ").replace(/\s+/g, " ");
    for (const [k, label] of pairs) assertStringIncludes(text, `${k} ${label}`, `${width}`);
  }
  assertEquals(keys(pairs, theme, 119).length, 2);
});

Deno.test("fitView: the first layout that fits the window; never the top cut off", () => {
  const layout = (n: number, tag: string) => () => Array.from({ length: n }, (_, i) => `${tag}${i}`);
  const layouts = [layout(40, "full"), layout(30, "short"), layout(20, "compact")];
  assertEquals(fitView(layouts, 45)[0], "full0");
  assertEquals(fitView(layouts, 32)[0], "short0", "explanations dropped first");
  assertEquals(fitView(layouts, 25)[0], "compact0");
  const tiny = fitView(layouts, 10);
  assertEquals(tiny.length, 10);
  assertEquals(tiny[0], "compact0", "the top line always shows");
});

Deno.test("tiny windows: boxes and the header never throw", () => {
  for (const width of [0, 1, 4, 6, 10]) {
    box("Choose a look", ["x"], { width, theme });
    header({ theme, screen: "looks", version: "1.0.0", width });
  }
});

Deno.test("looks grid: every swatch starts in the same column, even after the longest name", () => {
  const lines = looksGrid(allPresets(), { index: 14, width: 112, theme }).map(stripAnsi);
  const starts = (l: string) => [...l].flatMap((c, i) => (c === "\u{e0b6}" ? [i] : []));
  const first = starts(lines[0]);
  for (const l of lines.slice(1)) assertEquals(starts(l).slice(0, first.length), first, l);
});
