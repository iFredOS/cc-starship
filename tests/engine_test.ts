import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { install, setTheme, uninstall } from "../src/engine.ts";
import { tempDir } from "./helpers.ts";

const sha = (path: string) => {
  try {
    return createHash("sha256").update(Deno.readFileSync(path)).digest("hex");
  } catch {
    return "missing";
  }
};

/** A throwaway home with the env pointed at it; returns its paths. */
function sandbox() {
  const home = tempDir();
  const env = {
    HOME: home,
    USERPROFILE: home,
    STARSHIP_STATUSLINE_HOME: join(home, "install"),
    STARSHIP_STATUSLINE_PROFILES: join(home, ".zshrc"),
  };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = Deno.env.get(k);
    Deno.env.set(k, v);
  }
  for (const k of ["CLAUDE_CONFIG_DIR", "STARSHIP_CONFIG"]) {
    saved[k] = Deno.env.get(k);
    Deno.env.delete(k);
  }
  Deno.mkdirSync(join(home, ".config"));
  Deno.mkdirSync(join(home, ".claude"));
  return {
    home,
    starship: join(home, ".config", "starship.toml"),
    settings: join(home, ".claude", "settings.json"),
    zshrc: join(home, ".zshrc"),
    installDir: join(home, "install"),
    restore() {
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
    },
  };
}

const opts = (s: ReturnType<typeof sandbox>) => ({
  starship: "/usr/local/bin/starship",
  bin: join(s.installDir, "bin", "x"),
});

Deno.test("install, switch theme, uninstall: existing files come back byte-identical", async () => {
  const s = sandbox();
  try {
    Deno.writeTextFileSync(s.starship, "# my own prompt\nformat = '$all'\n");
    Deno.writeTextFileSync(
      s.settings,
      '{\n  "model": "opus",\n  "statusLine": {"type": "command", "command": "node old.mjs"}\n}\n',
    );
    Deno.writeTextFileSync(s.zshrc, "export PATH=$HOME/bin:$PATH\n");
    const before = [s.starship, s.settings, s.zshrc].map(sha);

    await install("rainbow", opts(s));
    assertStringIncludes(Deno.readTextFileSync(s.starship), "palette = 'rainbow'");
    const settings = JSON.parse(Deno.readTextFileSync(s.settings));
    assertEquals(settings.model, "opus");
    assertStringIncludes(settings.statusLine.command, "statusline");
    assertEquals(settings.statusLine.refreshInterval, 60);
    assertStringIncludes(Deno.readTextFileSync(s.zshrc), "eval \"$('/usr/local/bin/starship' init zsh)\"");

    await setTheme("ember");
    assertStringIncludes(Deno.readTextFileSync(s.starship), "palette = 'ember'");
    assertStringIncludes(Deno.readTextFileSync(join(s.installDir, "statusline.toml")), "palette = 'ember'");

    const report = await uninstall();
    assertEquals([s.starship, s.settings, s.zshrc].map(sha), before, report.join("\n"));
    assert(!exists(s.installDir), "install folder removed");
  } finally {
    s.restore();
  }
});

Deno.test("files the installer created are removed again", async () => {
  const s = sandbox();
  try {
    await install("gray", opts(s));
    assert(exists(s.starship) && exists(s.settings) && exists(s.zshrc));
    await uninstall();
    for (const f of [s.starship, s.settings, s.zshrc]) assert(!exists(f), f);
  } finally {
    s.restore();
  }
});

Deno.test("a symlinked starship.toml comes back as the same symlink", async () => {
  const s = sandbox();
  try {
    const target = join(s.home, "dev-shell.toml");
    Deno.writeTextFileSync(target, "# dev\n");
    Deno.symlinkSync(target, s.starship);
    await install("rainbow", opts(s));
    assertEquals(Deno.lstatSync(s.starship).isSymlink, false, "replaced by a real file");
    assertEquals(Deno.readTextFileSync(target), "# dev\n", "link target untouched");
    await uninstall();
    assert(Deno.lstatSync(s.starship).isSymlink);
    assertEquals(Deno.readLinkSync(s.starship), target);
  } finally {
    s.restore();
  }
});

Deno.test("a profile that already starts Starship is left alone", async () => {
  const s = sandbox();
  try {
    Deno.writeTextFileSync(s.zshrc, 'eval "$(starship init zsh)"\n');
    const before = sha(s.zshrc);
    await install("rainbow", opts(s));
    assertEquals(sha(s.zshrc), before);
    await uninstall();
    assertEquals(sha(s.zshrc), before);
  } finally {
    s.restore();
  }
});

Deno.test("a second install keeps the record of the original state", async () => {
  const s = sandbox();
  try {
    Deno.writeTextFileSync(s.starship, "# original\n");
    const before = sha(s.starship);
    await install("rainbow", opts(s));
    await install("ember", opts(s));
    await uninstall();
    assertEquals(sha(s.starship), before);
  } finally {
    s.restore();
  }
});

Deno.test("settings.json with comments: clear error, nothing changed", async () => {
  const s = sandbox();
  try {
    Deno.writeTextFileSync(s.starship, "# mine\n");
    Deno.writeTextFileSync(s.settings, '{\n  // my comment\n  "model": "opus",\n}\n');
    const before = [s.starship, s.settings, s.zshrc].map(sha);
    await assertRejects(() => install("rainbow", opts(s)), Error, "comments");
    assertEquals([s.starship, s.settings, s.zshrc].map(sha), before);
  } finally {
    s.restore();
  }
});

Deno.test("settings edited after install: the edit survives, statusLine reverts", async () => {
  const s = sandbox();
  try {
    Deno.writeTextFileSync(s.settings, '{"statusLine": {"type": "command", "command": "node old.mjs"}}\n');
    await install("rainbow", opts(s));
    const edited = JSON.parse(Deno.readTextFileSync(s.settings));
    edited.theme = "dark";
    Deno.writeTextFileSync(s.settings, JSON.stringify(edited, null, 2));
    await uninstall();
    const after = JSON.parse(Deno.readTextFileSync(s.settings));
    assertEquals(after.theme, "dark");
    assertEquals(after.statusLine, { type: "command", command: "node old.mjs" });
  } finally {
    s.restore();
  }
});

Deno.test("a Windows-style profile (BOM, CRLF) comes back exact", async () => {
  const s = sandbox();
  try {
    const bytes = new TextEncoder().encode("﻿Set-Alias ll Get-ChildItem\r\n$env:EDITOR = 'code'");
    Deno.writeFileSync(s.zshrc, bytes);
    const before = sha(s.zshrc);
    await install("rainbow", opts(s));
    const text = Deno.readTextFileSync(s.zshrc);
    assert(text.startsWith("﻿"), "BOM kept");
    assert(!/[^\r]\n/.test(text), "CRLF only");
    await uninstall();
    assertEquals(sha(s.zshrc), before);
  } finally {
    s.restore();
  }
});

function exists(path: string): boolean {
  try {
    Deno.lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
