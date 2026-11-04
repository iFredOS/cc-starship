import { assertEquals } from "@std/assert";
import { join } from "node:path";
import { accountName, usageFile } from "../src/paths.ts";

const HOME = "/Users/me";
const DIR = "/Users/me/.local/share/cc-starship";

Deno.test("the stock ~/.claude (or no CLAUDE_CONFIG_DIR) is the main account", () => {
  assertEquals(accountName(undefined, HOME), "main");
  assertEquals(accountName("", HOME), "main");
  assertEquals(accountName("/Users/me/.claude", HOME), "main");
  assertEquals(accountName("/Users/me/.claude/", HOME), "main", "trailing slash");
});

Deno.test("another config dir is named like cca names it: ~/.claude-<name> is <name>", () => {
  assertEquals(accountName("/Users/me/.claude-ifcote@duck.com", HOME), "ifcote@duck.com");
  assertEquals(accountName("/Users/me/.claude-work/", HOME), "work");
});

Deno.test("a config dir not named .claude-<name> gets a stable short hash of its path", () => {
  const a = accountName("/Volumes/x/claude-config", HOME);
  assertEquals(/^[0-9a-f]{8}$/.test(a), true, a);
  assertEquals(accountName("/Volumes/x/claude-config/", HOME), a, "trailing slash: same account");
});

Deno.test("each account saves its 5h/7d usage in its own file; main keeps the old name", () => {
  assertEquals(usageFile(DIR, undefined, HOME), join(DIR, "usage"));
  assertEquals(usageFile(DIR, "/Users/me/.claude", HOME), join(DIR, "usage"));
  assertEquals(usageFile(DIR, "/Users/me/.claude-ifcote@duck.com", HOME), join(DIR, "usage-ifcote@duck.com"));
});
