import { assertEquals } from "@std/assert";
import { join, posix, win32 } from "node:path";
import { accountName, promptUsageFile, usageFile } from "../src/paths.ts";

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

Deno.test("a profile folder named ~/.claude-main doesn't share the stock account's file", () => {
  assertEquals(usageFile(DIR, "/Users/me/.claude-main", HOME), join(DIR, "usage-main"));
});

Deno.test("prompt usage: its own account's file when there is one (main stays main beside a profile)", () => {
  const dir = Deno.makeTempDirSync();
  Deno.writeTextFileSync(join(dir, "usage-ifcote@duck.com"), "x");
  Deno.writeTextFileSync(join(dir, "usage"), "x");
  Deno.utimeSync(join(dir, "usage"), 1000, 1000); // older than the profile's: still main's
  assertEquals(promptUsageFile(dir, undefined, HOME), join(dir, "usage"));
});

Deno.test("prompt usage: no file for its account (a profile-only user's shell) → the newest account's", () => {
  const dir = Deno.makeTempDirSync();
  Deno.writeTextFileSync(join(dir, "usage-work"), "x");
  Deno.writeTextFileSync(join(dir, "usage-old"), "x");
  Deno.utimeSync(join(dir, "usage-old"), 1000, 1000);
  assertEquals(promptUsageFile(dir, undefined, HOME), join(dir, "usage-work"));
  const empty = Deno.makeTempDirSync();
  assertEquals(promptUsageFile(empty, undefined, HOME), join(empty, "usage"), "none at all: its own name");
});

Deno.test("other spellings of the stock ~/.claude are still the main account", () => {
  const mac = { path: posix, caseless: true };
  assertEquals(accountName("/Users/me//.claude", HOME, mac), "main");
  assertEquals(accountName("/Users/me/./.claude", HOME, mac), "main");
  assertEquals(accountName("/Users/Me/.claude", HOME, mac), "main", "APFS is case-insensitive");
  const win = { path: win32, caseless: true };
  const home = "C:\\Users\\fcote";
  assertEquals(accountName("C:/Users/fcote/.claude", home, win), "main", "forward slashes");
  assertEquals(accountName("c:\\users\\fcote\\.claude\\", home, win), "main", "case, trailing backslash");
  assertEquals(accountName("C:\\Users\\fcote\\.claude-work", home, win), "work");
});

Deno.test("~/.claude-<name> uses its name only in the home folder; elsewhere a hash", () => {
  const mac = { path: posix, caseless: true };
  assertEquals(accountName("/Users/me/.claude-work", HOME, mac), "work");
  const elsewhere = accountName("/Volumes/x/.claude-work", HOME, mac);
  assertEquals(/^[0-9a-f]{8}$/.test(elsewhere), true, elsewhere);
  assertEquals(accountName("/Volumes/x//.claude-work/", HOME, mac), elsewhere, "same folder, same hash");
});
