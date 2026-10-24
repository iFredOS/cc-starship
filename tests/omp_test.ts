import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { ompNotes } from "../src/omp.ts";
import { tempDir } from "./helpers.ts";

Deno.test("oh-my-posh in a profile or the status line: a note on the conflict and the speed", () => {
  const dir = tempDir();
  const zshrc = join(dir, ".zshrc"), ps1 = join(dir, "profile.ps1"), clean = join(dir, "clean");
  Deno.writeTextFileSync(zshrc, 'export A=1\neval "$(oh-my-posh init zsh --config ~/x.omp.json)"\n');
  Deno.writeTextFileSync(ps1, "oh-my-posh init pwsh | Invoke-Expression\r\n");
  Deno.writeTextFileSync(clean, 'eval "$(starship init zsh)"\n');
  const notes = ompNotes([zshrc, ps1, clean, join(dir, "missing")], { command: "node statusline.mjs" });
  assertEquals(notes.length, 2, notes.join("\n"));
  assert(notes[0].includes(`${zshrc} line 2`), notes[0]);
  assert(notes.every((n) => /conflict/.test(n) && /faster/.test(n)), notes.join("\n"));
});

Deno.test("oh-my-posh drawing the Claude Code status line is noted too", () => {
  const notes = ompNotes([], { command: "oh-my-posh claude --config ~/.claude/theme.omp.json" });
  assertEquals(notes.length, 1);
  assert(notes[0].includes("status line"), notes[0]);
  assertEquals(ompNotes([], undefined), []);
});
