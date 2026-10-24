import { assert, assertEquals } from "@std/assert";
import { previewBlock } from "../src/tui.ts";
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
      "prompt cache",
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
