// The README describes the program as it is: these fail when one changes without the other.
import { assert, assertEquals } from "@std/assert";
import { HELP } from "../src/main.ts";
import { allPresets } from "../src/presets.ts";

const readme = Deno.readTextFileSync(new URL("../README.md", import.meta.url));
const commandBlock = readme.split("## Command line")[1].split("```")[1];
/** `cc-starship <word>` lines of a text, by their first word. */
const commands = (text: string) =>
  new Set(
    [...text.matchAll(/^\s*cc-starship (\S+)/gm)].map((m) => m[1]).filter((w) => /^[a-z-]/.test(w)),
  );
/** What follows `cc-starship <word>` on its line, without a trailing comment. */
const usage = (text: string, word: string) =>
  text.match(new RegExp(`^\\s*cc-starship ${word} (.*?)(\\s{2,}.*)?$`, "m"))?.[1].trim();

Deno.test("docs: every command a person types is in the README's command list", () => {
  // statusline, usage and hook are run by Claude Code and the shell, not by people.
  const internal = new Set(["statusline", "usage", "hook"]);
  const listed = (c: string) => new RegExp(`(^|\\s)${c}(\\s|$)`, "m").test(commandBlock);
  const missing = [...commands(HELP)].filter((c) => !internal.has(c) && !listed(c));
  assertEquals(missing, []);
});

Deno.test("docs: prefs and components take the same choices in the help and the README", () => {
  for (const word of ["prefs", "components", "install"]) {
    assertEquals(usage(commandBlock, word), usage(HELP, word), word);
  }
});

Deno.test("docs: the README counts the looks there are, and every image it shows exists", () => {
  const count = allPresets().length;
  const words = [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
    "twenty",
  ];
  assert(readme.includes(`**${count} looks**`), `the feature list says ${count} looks`);
  assert(new RegExp(`${words[count]} looks`, "i").test(readme), `the Looks section says ${words[count]}`);
  for (const p of allPresets()) assert(readme.includes(p.name), `${p.name} is listed`);
  for (const [, path] of readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    assert(Deno.statSync(new URL(`../${path}`, import.meta.url)).isFile, path);
  }
});
