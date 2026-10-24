import { assert, assertEquals } from "@std/assert";
import { componentLines, previewBlock } from "../src/tui.ts";
import type { Prefs } from "../src/when.ts";
import { stripAnsi } from "./helpers.ts";

const sample = ["BAR1", "BAR2", "BAR3", "PROMPT"];

Deno.test("preview shows the status bar and shell prompt apart, each with its title", () => {
  const lines = previewBlock(sample, { explain: false }).map(stripAnsi);
  const bar = lines.indexOf("Claude Code status bar");
  const shell = lines.indexOf("Shell prompt");
  assert(bar >= 0 && shell > bar, lines.join("\n"));
  assertEquals(lines.slice(bar + 1, bar + 4).map((l) => l.trim()), ["BAR1", "BAR2", "BAR3"]);
  assertEquals(lines[shell - 1], "", "a blank line separates them");
  assertEquals(lines[shell + 1].trim(), "PROMPT");
});

Deno.test("with explanations, each line is followed by what its parts mean", () => {
  const text = previewBlock(sample, { explain: true }).map(stripAnsi).join("\n");
  for (
    const part of [
      "model",
      "effort",
      "account",
      "branch or worktree",
      "lines changed",
      "session time",
      "context used",
      "5-hour limit",
      "7-day limit",
      "70%",
      "language versions",
      "Claude usage",
      "last command",
    ]
  ) assert(text.includes(part), part);
  // The explanation sits right under the line it describes.
  const lines = previewBlock(sample, { explain: true }).map(stripAnsi);
  assert(lines[lines.indexOf("  BAR1") + 1].includes("model"));
  assert(lines[lines.indexOf("  PROMPT") + 1].includes("user"));
});

const base = {
  installed: true,
  components: { bar: true, shell: true, usage: true, hook: false, memory: false, terminal: false },
  starship: { path: "/opt/homebrew/bin/starship", version: "1.27.0", managedBy: "brew" as const },
  latest: "1.27.0" as string | null | undefined,
  fonts: ["JetBrainsMono Nerd Font"],
  prefs: { language: "auto", clock: "auto" } as Prefs,
  locale: "en-CA",
};

Deno.test("components panel: switches, Starship version and font", () => {
  const text = componentLines(base, 0).map(stripAnsi).join("\n");
  assert(text.includes("[x] Claude Code status bar"), text);
  assert(text.includes("[x] Shell prompt"));
  assert(text.includes("[x] Claude usage in the prompt"));
  assert(text.includes("1.27.0") && text.includes("latest"));
  assert(text.includes("JetBrainsMono Nerd Font"));
  assert(stripAnsi(componentLines(base, 0)[0]).includes("▸"), "selected row marked");
});

Deno.test("components panel: update available, missing Starship, usage needing the prompt", () => {
  const outdated = componentLines({ ...base, starship: { ...base.starship, version: "1.26.0" } }, 7)
    .map(stripAnsi).join("\n");
  assert(outdated.includes("1.26.0 → 1.27.0"), outdated);
  const missing = componentLines({ ...base, starship: null }, 7).map(stripAnsi).join("\n");
  assert(missing.includes("not installed"), missing);
  const noShell = componentLines({
    ...base,
    components: { bar: true, shell: false, usage: true, hook: false, memory: false, terminal: false },
  }, 0)
    .map(stripAnsi).join("\n");
  assert(noShell.includes("[ ] Shell prompt") && noShell.includes("needs the shell prompt"), noShell);
  const noFont = componentLines({ ...base, fonts: [] }, 8).map(stripAnsi).join("\n");
  assert(noFont.includes("none found"), noFont);
});

Deno.test("components panel: language and clock rows show the choice and a sample", () => {
  const auto = componentLines(base, 9).map(stripAnsi).join("\n");
  assert(auto.includes("Language") && auto.includes("Auto (English)"), auto);
  assert(auto.includes("Clock") && auto.includes("Auto (12 h)"), auto);
  const fr = componentLines({ ...base, prefs: { language: "fr-CA", clock: "24h" } }, 9).map(stripAnsi).join(
    "\n",
  );
  assert(fr.includes("Français (Québec)") && fr.includes("24 h"), fr);
  assert(/(dim|lun|mar|mer|jeu|ven|sam)\. 18 h/.test(fr), "sample reset in the chosen format: " + fr);
});

Deno.test("components panel: the add-ons, and what the usage hook costs in tokens", () => {
  const all = { bar: true, shell: true, usage: true, hook: true, memory: true, terminal: true };
  const text = componentLines({ ...base, components: all }, 0).map(stripAnsi).join("\n");
  assert(text.includes("[x] Usage for Claude"), text);
  assert(/tokens per prompt/.test(text), "the token cost is shown up front: " + text);
  assert(text.includes("[x] Shell memory"), text);
  assert(text.includes("[x] Terminal settings") && text.includes("JetBrainsMono"), text);
  const noBar = componentLines({ ...base, components: { ...all, bar: false } }, 0).map(stripAnsi).join("\n");
  assert(noBar.includes("needs the status bar"), noBar);
});

Deno.test("components panel: when Claude starts getting usage", () => {
  const lines = (hookFrom?: number) =>
    componentLines({ ...base, prefs: { ...base.prefs, hookFrom } }, 0).map(stripAnsi).join("\n");
  assert(lines(undefined).includes("Send usage to Claude") && lines(undefined).includes("from 50%"), lines());
  assert(lines(0).includes("every prompt"), lines(0));
  assert(lines(90).includes("from 90%"), lines(90));
});
