import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import { memoryBlock, promptOffBlock } from "../src/memory.ts";
import { tempDir } from "./helpers.ts";

/** A home with a .zshrc holding only the memory block. */
function zshHome() {
  const home = Deno.realPathSync(tempDir());
  const lastdir = join(home, "install", "lastdir");
  Deno.writeTextFileSync(join(home, ".zshrc"), memoryBlock("zsh", lastdir));
  Deno.mkdirSync(join(home, "projects", "app"), { recursive: true });
  return { home, lastdir, app: join(home, "projects", "app") };
}

/** Runs an interactive zsh in `cwd`; CLAUDECODE is unset unless given. */
function zsh(home: string, cwd: string, command: string, env: Record<string, string> = {}): string {
  const base = Deno.env.toObject();
  delete base.CLAUDECODE;
  const out = new Deno.Command("zsh", {
    args: ["-i", "-c", command],
    cwd,
    env: { ...base, HOME: home, ZDOTDIR: home, ...env },
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  return new TextDecoder().decode(out.stdout).trim();
}

const exists = (p: string) => {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
};

Deno.test("zsh: the folder a person cd's into is remembered, and a new tab opens there", () => {
  const z = zshHome();
  zsh(z.home, z.home, "cd projects/app");
  assertEquals(Deno.readTextFileSync(z.lastdir).trim(), z.app);
  assertEquals(zsh(z.home, z.home, "pwd"), z.app, "a shell starting in home goes back there");
});

Deno.test("zsh: a shell started somewhere else stays there (restored tabs, cmux, editors)", () => {
  const z = zshHome();
  zsh(z.home, z.home, "cd projects/app");
  const other = join(z.home, "projects");
  assertEquals(zsh(z.home, other, "pwd"), other);
});

Deno.test("zsh: agents' shells don't move the remembered folder", () => {
  const z = zshHome();
  zsh(z.home, z.home, "cd projects/app");
  zsh(z.home, z.home, "cd projects", { CLAUDECODE: "1" });
  assertEquals(Deno.readTextFileSync(z.lastdir).trim(), z.app);
});

Deno.test("zsh: a remembered folder that was deleted is ignored", () => {
  const z = zshHome();
  zsh(z.home, z.home, "cd projects/app");
  Deno.removeSync(z.app);
  assertEquals(zsh(z.home, z.home, "pwd"), z.home);
});

Deno.test("zsh: history keeps one copy of each command, newest wins, shared across tabs", () => {
  const z = zshHome();
  const opts = zsh(
    z.home,
    z.home,
    "for o in histignorealldups histsavenodups incappendhistory; do [[ -o $o ]] && print $o; done; print $SAVEHIST",
  );
  assertEquals(opts.split("\n"), ["histignorealldups", "histsavenodups", "incappendhistory", "100000"]);
  assert(!exists(z.lastdir), "just starting a shell writes nothing");
});

Deno.test("PowerShell block: remembers through Starship's pre-command hook and dedups history", () => {
  const block = memoryBlock("powershell", "C:\\Users\\me\\AppData\\Local\\cc-starship\\lastdir");
  for (
    const part of [
      "Invoke-Starship-PreCommand",
      "HistoryNoDuplicates",
      "HistorySavePath",
      "CLAUDECODE",
      "C:\\Users\\me\\AppData\\Local\\cc-starship\\lastdir",
    ]
  ) assertStringIncludes(block, part);
  assert(!/function\s+(global:)?Set-Location/i.test(block), "doesn't override cd");
  const lines = block.trimEnd().split("\n");
  assertEquals(
    [lines[1], lines.at(-1)],
    ["& {", "}"],
    "runs in its own scope: no variables leak into the session",
  );
  assertStringIncludes(
    block,
    "$env:WINDIR",
    "a start in C:\\Windows (Run, some launchers) counts as no choice",
  );
});

Deno.test("zsh: a bigger history size you set yourself is kept (only ever raised)", () => {
  const z = zshHome();
  const rc = join(z.home, ".zshrc");
  Deno.writeTextFileSync(rc, "HISTSIZE=2000000\nSAVEHIST=1000000\n" + Deno.readTextFileSync(rc));
  assertEquals(zsh(z.home, z.home, "print $HISTSIZE $SAVEHIST"), "2000000 1000000");
});

Deno.test("PowerShell: curly quotes and apostrophes in the folder path stay inside the string", () => {
  const block = memoryBlock("powershell", "C:\\Users\\O’Brien's\\lastdir");
  assertStringIncludes(block, "$global:__sslLastDir = 'C:\\Users\\O’’Brien''s\\lastdir'");
});

Deno.test("PowerShell 'prompt off' block: PowerShell's own prompt, still saving the folder", () => {
  const block = promptOffBlock("powershell");
  assertStringIncludes(block, "function global:prompt");
  assertStringIncludes(block, "Invoke-Starship-PreCommand", "shell memory keeps working");
  assertStringIncludes(promptOffBlock("zsh"), "PROMPT='%n@%m %1~ %# '");
});
