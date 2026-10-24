import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { contrast, rgb } from "../src/color.ts";
import { box, clip, header, keys, looksGrid, swatch, themeOf, visibleWidth } from "../src/panel.ts";
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
    for (const p of presets) assertStringIncludes(text, p.name.replace(" v1", ""), `${width}: ${p.name}`);
    for (const l of lines) assert(visibleWidth(l) <= width, `${width}: ${stripAnsi(l)}`);
    assertStringIncludes(text, `▸ ${presets[2].name.replace(" v1", "")}`);
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
  const line = keys([["↑↓", "choose"], ["⏎", "use this look"], ["Q", "quit"]], theme);
  assertEquals(stripAnsi(line).replace(/\s+/g, " ").trim(), "↑↓ choose ⏎ use this look Q quit");
});
