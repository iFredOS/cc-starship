import { assertEquals } from "@std/assert";
import { join } from "node:path";
import { usageText } from "../src/usage.ts";
import { now, tempDir } from "./helpers.ts";

Deno.test("usage line for the shell prompt, zeroing a window once it resets", () => {
  const file = join(tempDir(), "usage");
  assertEquals(usageText(file), "", "no file yet: nothing");
  Deno.writeTextFileSync(file, `${now() + 3600} 42 ${now() + 86400} 23\n`);
  assertEquals(usageText(file), "✻ 5h 42% · 7d 23%");
  Deno.writeTextFileSync(file, `${now() - 60} 42 ${now() + 86400} 23\n`);
  assertEquals(usageText(file), "✻ 5h 0% · 7d 23%");
  Deno.writeTextFileSync(file, `0 42 0 23\n`);
  assertEquals(usageText(file), "✻ 5h 42% · 7d 23%", "unknown reset times: keep the numbers");
  Deno.writeTextFileSync(file, "garbage");
  assertEquals(usageText(file), "");
});

Deno.test("usage line: a window Claude Code didn't send is left out, not the whole line", () => {
  const file = join(tempDir(), "usage");
  Deno.writeTextFileSync(file, `0 - ${now() + 86400} 6\n`);
  assertEquals(usageText(file), "✻ 7d 6%", "no 5h window (seen after a plan upgrade)");
  Deno.writeTextFileSync(file, `${now() + 3600} 42 0 -\n`);
  assertEquals(usageText(file), "✻ 5h 42%");
  Deno.writeTextFileSync(file, `0 - 0 -\n`);
  assertEquals(usageText(file), "");
});
