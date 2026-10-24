import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  ALL_COMPONENTS,
  install,
  readInstalled,
  refreshProfilePaths,
  setComponents,
  setPrefs,
  setTheme,
  uninstall,
} from "../src/engine.ts";
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
    CC_STARSHIP_HOME: join(home, "install"),
    CC_STARSHIP_PROFILES: join(home, ".zshrc"),
    // Never the real terminal settings; tests that want some list them.
    CC_STARSHIP_TERMINALS: "",
    // Uninstall cleans the temp folder: never the real one.
    TMPDIR: join(home, "tmp"),
    TEMP: join(home, "tmp"),
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
  Deno.mkdirSync(join(home, "tmp"));
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
    await install("fusain", opts(s));
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
    await install("rainbow", {
      ...opts(s),
      components: { ...ALL_COMPONENTS, memory: false, terminal: false },
    });
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

Deno.test("components: bar only leaves the shell alone; toggling restores each part exactly", async () => {
  const s = sandbox();
  try {
    Deno.writeTextFileSync(s.starship, "# mine\n");
    Deno.writeTextFileSync(s.settings, '{"model": "opus"}\n');
    Deno.writeTextFileSync(s.zshrc, "export A=1\n");
    const [starship0, settings0, zshrc0] = [s.starship, s.settings, s.zshrc].map(sha);

    await install("rainbow", {
      ...opts(s),
      components: { bar: true, shell: false, usage: false, hook: false, memory: false, terminal: false },
    });
    assertEquals(sha(s.starship), starship0, "shell prompt untouched");
    assertEquals(sha(s.zshrc), zshrc0, "profile untouched");
    assertStringIncludes(Deno.readTextFileSync(s.settings), "statusline");

    await setComponents({ bar: true, shell: true, usage: true, hook: false, memory: false, terminal: false });
    assertStringIncludes(Deno.readTextFileSync(s.starship), "${custom.claude}");
    assertStringIncludes(Deno.readTextFileSync(s.zshrc), "init zsh");

    await setComponents({
      bar: false,
      shell: true,
      usage: false,
      hook: false,
      memory: false,
      terminal: false,
    });
    assertEquals(
      sha(s.settings),
      settings0,
      "status bar off, nothing set before: settings.json back exactly",
    );
    assert(!Deno.readTextFileSync(s.starship).includes("${custom.claude}"), "usage segment gone");

    await uninstall();
    assertEquals([s.starship, s.settings, s.zshrc].map(sha), [starship0, settings0, zshrc0]);
  } finally {
    s.restore();
  }
});

Deno.test("language and clock are saved with the install and touch no config file", async () => {
  const s = sandbox();
  try {
    await install("rainbow", { ...opts(s), prefs: { language: "fr-CA", clock: "auto" } });
    assertEquals(readInstalled()?.prefs, { language: "fr-CA", clock: "auto" });
    const files = [s.starship, s.settings, s.zshrc].map(sha);
    await setPrefs({ language: "en", clock: "12h" });
    assertEquals(readInstalled()?.prefs, { language: "en", clock: "12h" });
    assertEquals([s.starship, s.settings, s.zshrc].map(sha), files);
    await install("ember", opts(s));
    assertEquals(readInstalled()?.prefs, { language: "en", clock: "12h" }, "a reinstall keeps them");
  } finally {
    s.restore();
  }
});

Deno.test("usage hook: added next to the user's own hooks, removed again exactly", async () => {
  const s = sandbox();
  try {
    const mine = {
      model: "opus",
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo mine" }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }],
      },
    };
    Deno.writeTextFileSync(s.settings, JSON.stringify(mine, null, 2) + "\n");
    const before = sha(s.settings);

    await install("rainbow", { ...opts(s), components: { ...ALL_COMPONENTS, hook: true } });
    const on = JSON.parse(Deno.readTextFileSync(s.settings));
    const commands = on.hooks.UserPromptSubmit.flatMap((g: { hooks: { command: string }[] }) =>
      g.hooks.map((h) => h.command)
    );
    assert(commands.includes("echo mine"), "the user's hook kept");
    assert(commands.some((c: string) => c.endsWith(" hook")), JSON.stringify(commands));
    assertEquals(on.hooks.PreToolUse, mine.hooks.PreToolUse);

    await setComponents({ ...ALL_COMPONENTS, hook: false, memory: false, terminal: false });
    const off = JSON.parse(Deno.readTextFileSync(s.settings));
    assertEquals(off.hooks, mine.hooks, "only our hook removed");
    assertStringIncludes(off.statusLine.command, "statusline", "status bar still on");

    await setComponents({ ...ALL_COMPONENTS, hook: true });
    await uninstall();
    assertEquals(sha(s.settings), before);
  } finally {
    s.restore();
  }
});

Deno.test("status bar off means no status bar, even where another one was set before", async () => {
  const s = sandbox();
  try {
    Deno.writeTextFileSync(s.settings, '{"statusLine": {"type": "command", "command": "node old.mjs"}}\n');
    const before = sha(s.settings);
    await install("rainbow", { ...opts(s), components: { ...ALL_COMPONENTS, bar: false, hook: true } });
    const data = JSON.parse(Deno.readTextFileSync(s.settings));
    assertEquals(data.statusLine, undefined, "the old status bar doesn't come back while ours is off");
    assertEquals(data.hooks.UserPromptSubmit.length, 1);
    await setComponents({ ...ALL_COMPONENTS, bar: false, hook: false });
    assertEquals(JSON.parse(Deno.readTextFileSync(s.settings)), {}, "both off: nothing left");
    await uninstall();
    assertEquals(sha(s.settings), before, "uninstall puts the previous status bar back");
  } finally {
    s.restore();
  }
});

Deno.test("status bar off with nothing set before: settings.json back exactly", async () => {
  const s = sandbox();
  try {
    Deno.writeTextFileSync(s.settings, '{"model": "opus"}\n');
    const before = sha(s.settings);
    await install("rainbow", opts(s));
    await setComponents({ ...ALL_COMPONENTS, bar: false, hook: false });
    assertEquals(sha(s.settings), before);
  } finally {
    s.restore();
  }
});

Deno.test("shell prompt off means the shell's own prompt, even if the profile starts Starship itself", async () => {
  const s = sandbox();
  try {
    Deno.writeTextFileSync(s.zshrc, 'export A=1\neval "$(starship init zsh)"\n');
    const before = sha(s.zshrc);
    await install("rainbow", { ...opts(s), components: { ...ALL_COMPONENTS, memory: false } });
    assertEquals(sha(s.zshrc), before, "on: the profile's own Starship line is enough");
    await setComponents({ ...ALL_COMPONENTS, shell: false, usage: false, memory: false });
    const off = Deno.readTextFileSync(s.zshrc);
    assertStringIncludes(off, "# >>> cc-starship prompt off >>>");
    // A real interactive zsh, with the real Starship: the prompt is zsh's own.
    const env = { ...Deno.env.toObject(), HOME: s.home, ZDOTDIR: s.home };
    delete (env as Record<string, string>).CLAUDECODE;
    const out = new Deno.Command("zsh", {
      args: ["-i", "-c", 'print -r -- "$PROMPT|${precmd_functions[*]}"'],
      env,
      clearEnv: true,
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    const [prompt, hooks] = new TextDecoder().decode(out.stdout).trim().split("|");
    assertEquals(prompt, "%n@%m %1~ %# ");
    assert(!hooks.includes("starship"), hooks);
    await setComponents({ ...ALL_COMPONENTS, memory: false });
    assertEquals(sha(s.zshrc), before, "on again: the off block is gone");
    await setComponents({ ...ALL_COMPONENTS, shell: false, usage: false, memory: false });
    await uninstall();
    assertEquals(sha(s.zshrc), before, "uninstall: exactly as before");
  } finally {
    s.restore();
  }
});

Deno.test("an install from before the hook existed reads as hook off", async () => {
  const s = sandbox();
  try {
    await install("rainbow", opts(s));
    const state = JSON.parse(Deno.readTextFileSync(join(s.installDir, "state.json")));
    state.components = { bar: true, shell: true, usage: true, hook: false, memory: false, terminal: false };
    Deno.writeTextFileSync(join(s.installDir, "state.json"), JSON.stringify(state));
    assertEquals(readInstalled()?.components.hook, false);
  } finally {
    s.restore();
  }
});

Deno.test("shell memory: its own block in each profile, removed exactly when switched off", async () => {
  const s = sandbox();
  try {
    Deno.writeTextFileSync(s.zshrc, "export A=1\n");
    const before = sha(s.zshrc);
    await install("rainbow", { ...opts(s), components: { ...ALL_COMPONENTS, shell: false, memory: true } });
    const text = Deno.readTextFileSync(s.zshrc);
    assertStringIncludes(text, "# >>> cc-starship memory >>>");
    assertStringIncludes(text, join(s.installDir, "lastdir"));
    assert(!text.includes("init zsh"), "the prompt part is separate");

    await setComponents({ ...ALL_COMPONENTS, shell: true, memory: true });
    await setComponents({ ...ALL_COMPONENTS, shell: true, memory: false, terminal: false });
    assert(!Deno.readTextFileSync(s.zshrc).includes("memory >>>"));
    assertStringIncludes(Deno.readTextFileSync(s.zshrc), "init zsh");

    await setComponents({ ...ALL_COMPONENTS, memory: true });
    await uninstall();
    assertEquals(sha(s.zshrc), before);
  } finally {
    s.restore();
  }
});

Deno.test("terminal settings: cmux/Ghostty get a block, removed exactly", async () => {
  const s = sandbox();
  try {
    const cmux = join(s.home, "config.ghostty");
    Deno.writeTextFileSync(
      cmux,
      'theme = "Midnight In Mojave"\nfont-family = "JetBrainsMono Nerd Font"\nfont-size = 18',
    );
    Deno.env.set("CC_STARSHIP_TERMINALS", cmux);
    const before = sha(cmux);
    await install("rainbow", { ...opts(s), components: { ...ALL_COMPONENTS, terminal: true } });
    const text = Deno.readTextFileSync(cmux);
    assert(text.startsWith('theme = "Midnight In Mojave"\n'), "the user's lines stay");
    const block = text.slice(text.indexOf("# >>> cc-starship terminal >>>"));
    for (
      const line of [
        'font-family = ""',
        'font-family = "JetBrainsMono Nerd Font"',
        "font-size = 14",
        "macos-option-as-alt = left",
      ]
    ) assertStringIncludes(block, line);
    await setComponents({ ...ALL_COMPONENTS, terminal: false });
    assertEquals(sha(cmux), before);
  } finally {
    s.restore();
  }
});

const wtSettings = {
  defaultProfile: "{1}",
  profiles: {
    defaults: {},
    list: [
      { guid: "{1}", name: "Windows PowerShell", font: { face: "Cascadia Code NF" } },
      { guid: "{2}", name: "PowerShell", font: { face: "CaskaydiaCove NF", size: 13, weight: "normal" } },
      { guid: "{3}", name: "Old", fontFace: "Consolas", fontSize: 11 },
      { guid: "{4}", name: "Command Prompt" },
    ],
  },
};

Deno.test("terminal settings: Windows Terminal default font, per-profile fonts cleared, restored exactly", async () => {
  const s = sandbox();
  try {
    const wt = join(s.home, "settings.json.wt.json");
    Deno.writeTextFileSync(wt, JSON.stringify(wtSettings, null, 4) + "\n");
    Deno.env.set("CC_STARSHIP_TERMINALS", wt);
    const before = sha(wt);
    await install("rainbow", { ...opts(s), components: { ...ALL_COMPONENTS, terminal: true } });
    const on = JSON.parse(Deno.readTextFileSync(wt));
    assertEquals(on.profiles.defaults.font, { face: "JetBrainsMono Nerd Font", size: 14 });
    assertEquals(on.profiles.list[0].font, undefined);
    assertEquals(on.profiles.list[1].font, { weight: "normal" }, "only face and size go");
    assertEquals([on.profiles.list[2].fontFace, on.profiles.list[2].fontSize], [undefined, undefined]);
    await uninstall();
    assertEquals(sha(wt), before);
  } finally {
    s.restore();
  }
});

Deno.test("terminal settings: Windows Terminal edited since: fonts put back, other edits kept", async () => {
  const s = sandbox();
  try {
    const wt = join(s.home, "settings.json.wt.json");
    Deno.writeTextFileSync(wt, JSON.stringify(wtSettings, null, 4) + "\n");
    Deno.env.set("CC_STARSHIP_TERMINALS", wt);
    await install("rainbow", { ...opts(s), components: { ...ALL_COMPONENTS, terminal: true } });
    const edited = JSON.parse(Deno.readTextFileSync(wt));
    edited.theme = "dark";
    Deno.writeTextFileSync(wt, JSON.stringify(edited, null, 4));
    await setComponents({ ...ALL_COMPONENTS, terminal: false });
    const after = JSON.parse(Deno.readTextFileSync(wt));
    assertEquals(after.theme, "dark");
    assertEquals(after.profiles, wtSettings.profiles);
  } finally {
    s.restore();
  }
});

Deno.test("terminal settings: Windows Terminal with comments is left alone", async () => {
  const s = sandbox();
  try {
    const wt = join(s.home, "settings.json.wt.json");
    Deno.writeTextFileSync(wt, '{\n  // mine\n  "profiles": {}\n}\n');
    Deno.env.set("CC_STARSHIP_TERMINALS", wt);
    const before = sha(wt);
    const report = await install("rainbow", {
      ...opts(s),
      components: { ...ALL_COMPONENTS, terminal: true },
    });
    assertEquals(sha(wt), before);
    assert(report.some((l) => l.includes("comments")), report.join("\n"));
    await uninstall();
    assertEquals(sha(wt), before);
  } finally {
    s.restore();
  }
});

Deno.test("a hook left by the old starship-statusline name is replaced, not doubled", async () => {
  const s = sandbox();
  try {
    const old = '"/Users/me/.local/share/starship-statusline/bin/starship-statusline" hook';
    Deno.writeTextFileSync(
      s.settings,
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: old }] }] } }),
    );
    await install("rainbow", { ...opts(s), components: { ...ALL_COMPONENTS, hook: true } });
    const groups = JSON.parse(Deno.readTextFileSync(s.settings)).hooks.UserPromptSubmit;
    assertEquals(groups.length, 1, JSON.stringify(groups));
    assert(!JSON.stringify(groups).includes("starship-statusline"));
  } finally {
    s.restore();
  }
});

Deno.test("settings changes made between installs survive uninstall", async () => {
  const s = sandbox();
  try {
    Deno.writeTextFileSync(s.settings, '{"model": "opus"}\n');
    await install("rainbow", opts(s));
    // You add a permission; a later theme switch rewrites the file with it included.
    const data = JSON.parse(Deno.readTextFileSync(s.settings));
    data.permissions = { allow: ["Bash(ls)"] };
    Deno.writeTextFileSync(s.settings, JSON.stringify(data, null, 2) + "\n");
    await setTheme("ember");
    await uninstall();
    assertEquals(JSON.parse(Deno.readTextFileSync(s.settings)), {
      model: "opus",
      permissions: { allow: ["Bash(ls)"] },
    });
  } finally {
    s.restore();
  }
});

Deno.test("Windows Terminal changes made between installs survive uninstall", async () => {
  const s = sandbox();
  try {
    const wt = join(s.home, "settings.json.wt.json");
    Deno.writeTextFileSync(wt, JSON.stringify(wtSettings, null, 4) + "\n");
    Deno.env.set("CC_STARSHIP_TERMINALS", wt);
    await install("rainbow", { ...opts(s), components: { ...ALL_COMPONENTS, terminal: true } });
    const data = JSON.parse(Deno.readTextFileSync(wt));
    data.theme = "dark";
    Deno.writeTextFileSync(wt, JSON.stringify(data, null, 4) + "\n");
    await setComponents({ ...ALL_COMPONENTS, terminal: false });
    assertEquals(JSON.parse(Deno.readTextFileSync(wt)).theme, "dark");
  } finally {
    s.restore();
  }
});

Deno.test("profile without a final newline: blocks removed in any order leave valid, exact text", async () => {
  const s = sandbox();
  try {
    Deno.writeTextFileSync(s.zshrc, "export A=1");
    const before = sha(s.zshrc);
    await install("rainbow", { ...opts(s), components: { ...ALL_COMPONENTS, terminal: false } });
    await setComponents({ ...ALL_COMPONENTS, shell: false, usage: false, terminal: false });
    const text = Deno.readTextFileSync(s.zshrc);
    assert(text.startsWith("export A=1\n# >>> cc-starship memory >>>"), JSON.stringify(text.slice(0, 50)));
    await setComponents({ ...ALL_COMPONENTS, shell: false, usage: false, memory: false, terminal: false });
    assertEquals(sha(s.zshrc), before);
  } finally {
    s.restore();
  }
});

Deno.test("a symlinked settings.json comes back as the same link", async () => {
  const s = sandbox();
  try {
    const target = join(s.home, "dotfiles-settings.json");
    Deno.writeTextFileSync(target, '{"model": "opus"}\n');
    Deno.symlinkSync(target, s.settings);
    await install("rainbow", opts(s));
    await uninstall();
    assert(Deno.lstatSync(s.settings).isSymlink, "the link is back");
    assertEquals(Deno.readLinkSync(s.settings), target);
    assertEquals(Deno.readTextFileSync(target), '{"model": "opus"}\n');
  } finally {
    s.restore();
  }
});

Deno.test("switching the hook off keeps the user's hook that shares our group", async () => {
  const s = sandbox();
  try {
    await install("rainbow", opts(s));
    const data = JSON.parse(Deno.readTextFileSync(s.settings));
    data.hooks.UserPromptSubmit[0].hooks.push({ type: "command", command: "echo mine" });
    Deno.writeTextFileSync(s.settings, JSON.stringify(data, null, 2));
    await setComponents({ ...ALL_COMPONENTS, hook: false });
    assertEquals(JSON.parse(Deno.readTextFileSync(s.settings)).hooks, {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo mine" }] }],
    });
  } finally {
    s.restore();
  }
});

Deno.test("commands are quoted only when the path has spaces (PowerShell can't run a quoted path)", async () => {
  const s = sandbox();
  try {
    await install("rainbow", opts(s));
    const data = JSON.parse(Deno.readTextFileSync(s.settings));
    assertEquals(data.statusLine.command, `${join(s.installDir, "bin", "x")} statusline`);
    assertEquals(data.hooks.UserPromptSubmit[0].hooks[0].command, `${join(s.installDir, "bin", "x")} hook`);
    await install("rainbow", { ...opts(s), bin: join(s.home, "my apps", "x") });
    const spaced = JSON.parse(Deno.readTextFileSync(s.settings));
    assertEquals(spaced.statusLine.command, `"${join(s.home, "my apps", "x")}" statusline`);
    assertEquals(spaced.hooks.UserPromptSubmit.length, 1, "the old unquoted hook was replaced");
  } finally {
    s.restore();
  }
});

Deno.test("Windows Terminal: a font change made after install is kept, ours taken out", async () => {
  const s = sandbox();
  try {
    const wt = join(s.home, "settings.json.wt.json");
    Deno.writeTextFileSync(wt, JSON.stringify(wtSettings, null, 4) + "\n");
    Deno.env.set("CC_STARSHIP_TERMINALS", wt);
    await install("rainbow", { ...opts(s), components: { ...ALL_COMPONENTS, terminal: true } });
    const data = JSON.parse(Deno.readTextFileSync(wt));
    data.profiles.defaults.font.weight = "bold";
    data.profiles.list[1].font = { weight: "light" };
    Deno.writeTextFileSync(wt, JSON.stringify(data, null, 4));
    await setComponents({ ...ALL_COMPONENTS, terminal: false });
    const after = JSON.parse(Deno.readTextFileSync(wt));
    assertEquals(after.profiles.defaults.font, { weight: "bold" });
    assertEquals(after.profiles.list[1].font, { face: "CaskaydiaCove NF", size: 13, weight: "light" });
  } finally {
    s.restore();
  }
});

Deno.test("an install from the old starship-statusline folder must be moved over first", async () => {
  const s = sandbox();
  try {
    const old = join(s.home, ".local", "share", "starship-statusline");
    Deno.mkdirSync(old, { recursive: true });
    Deno.writeTextFileSync(join(old, "manifest.json"), "{}");
    await assertRejects(() => install("rainbow", opts(s)), Error, "CC_STARSHIP_HOME");
  } finally {
    s.restore();
  }
});

Deno.test("commands stay quoted for paths bash would misread ($, quotes, &)", async () => {
  const s = sandbox();
  try {
    const bin = join(s.home, "O'Brien$x", "cc");
    await install("rainbow", { ...opts(s), bin });
    assertEquals(JSON.parse(Deno.readTextFileSync(s.settings)).statusLine.command, `"${bin}" statusline`);
  } finally {
    s.restore();
  }
});

Deno.test("a symlinked settings.json edited since install: the link comes back, the edits are saved beside it", async () => {
  const s = sandbox();
  try {
    const target = join(s.home, "dotfiles-settings.json");
    Deno.writeTextFileSync(target, '{"model": "opus"}\n');
    Deno.symlinkSync(target, s.settings);
    await install("rainbow", opts(s));
    const data = JSON.parse(Deno.readTextFileSync(s.settings));
    data.theme = "dark";
    Deno.writeTextFileSync(s.settings, JSON.stringify(data));
    const report = await uninstall();
    assertEquals(Deno.readLinkSync(s.settings), target);
    assertEquals(Deno.readTextFileSync(target), '{"model": "opus"}\n', "the dotfile is untouched");
    const saved = `${s.settings}.cc-starship-edits.json`;
    assertEquals(JSON.parse(Deno.readTextFileSync(saved)), { model: "opus", theme: "dark" });
    assert(report.some((l) => l.includes(saved)), report.join("\n"));
  } finally {
    s.restore();
  }
});

Deno.test("blocks written by an older version are refreshed on the next apply", async () => {
  const s = sandbox();
  try {
    const cmux = join(s.home, "config.ghostty");
    Deno.writeTextFileSync(cmux, "theme = x\n");
    Deno.env.set("CC_STARSHIP_TERMINALS", cmux);
    const before = sha(cmux);
    await install("rainbow", { ...opts(s), components: { ...ALL_COMPONENTS, terminal: true } });
    // Pretend an older version wrote size 15: in the file and in the manifest's record.
    const manifestPath = join(s.installDir, "manifest.json");
    const old = (x: string) => x.replaceAll("font-size = 14", "font-size = 15");
    Deno.writeTextFileSync(cmux, old(Deno.readTextFileSync(cmux)));
    Deno.writeTextFileSync(manifestPath, old(Deno.readTextFileSync(manifestPath)));
    await setTheme("ember");
    const text = Deno.readTextFileSync(cmux);
    assertStringIncludes(text, "font-size = 14");
    assert(!text.includes("font-size = 15"), text);
    assertEquals(text.match(/cc-starship terminal >>>/g)?.length, 1, "one block, not two");
    await uninstall();
    assertEquals(sha(cmux), before);
  } finally {
    s.restore();
  }
});

Deno.test("Windows Terminal font from an older version is brought up to date, prior fonts kept", async () => {
  const s = sandbox();
  try {
    const wt = join(s.home, "settings.json.wt.json");
    Deno.writeTextFileSync(wt, JSON.stringify(wtSettings, null, 4) + "\n");
    Deno.env.set("CC_STARSHIP_TERMINALS", wt);
    const before = sha(wt);
    await install("rainbow", { ...opts(s), components: { ...ALL_COMPONENTS, terminal: true } });
    const data = JSON.parse(Deno.readTextFileSync(wt));
    data.profiles.defaults.font.size = 15; // what an older version wrote
    Deno.writeTextFileSync(wt, JSON.stringify(data, null, 4) + "\n");
    const manifestPath = join(s.installDir, "manifest.json");
    const manifest = JSON.parse(Deno.readTextFileSync(manifestPath));
    delete manifest.windowsTerminal.font; // older versions didn't record it
    Deno.writeTextFileSync(manifestPath, JSON.stringify(manifest));
    await setTheme("ember");
    assertEquals(JSON.parse(Deno.readTextFileSync(wt)).profiles.defaults.font, {
      face: "JetBrainsMono Nerd Font",
      size: 14,
    });
    await uninstall();
    assertEquals(sha(wt), before);
  } finally {
    s.restore();
  }
});

Deno.test("profile paths are found once at install and reused by later switches", async () => {
  const s = sandbox();
  try {
    Deno.env.delete("CC_STARSHIP_PROFILES"); // real discovery (on macOS: ~/.zshrc)
    await install("rainbow", { ...opts(s), components: { ...ALL_COMPONENTS, memory: false } });
    const statePath = join(s.installDir, "state.json");
    const state = JSON.parse(Deno.readTextFileSync(statePath));
    assert(Array.isArray(state.profilePaths) && state.profilePaths.length > 0, JSON.stringify(state));
    // A later switch uses the saved list instead of asking the shells again.
    const other = join(s.home, "other.zshrc");
    Deno.writeTextFileSync(statePath, JSON.stringify({ ...state, profilePaths: [other] }));
    await setComponents({ ...ALL_COMPONENTS, memory: true });
    assertStringIncludes(Deno.readTextFileSync(other), "cc-starship memory >>>");
  } finally {
    s.restore();
  }
});

Deno.test("refreshing an old block: in place, so lines you added after it still win", async () => {
  const s = sandbox();
  try {
    const cmux = join(s.home, "config.ghostty");
    Deno.writeTextFileSync(cmux, "theme = x\n");
    Deno.env.set("CC_STARSHIP_TERMINALS", cmux);
    await install("rainbow", { ...opts(s), components: { ...ALL_COMPONENTS, terminal: true } });
    const manifestPath = join(s.installDir, "manifest.json");
    const old = (x: string) => x.replaceAll("font-size = 14", "font-size = 15");
    Deno.writeTextFileSync(cmux, old(Deno.readTextFileSync(cmux)) + "font-size = 18\n");
    Deno.writeTextFileSync(manifestPath, old(Deno.readTextFileSync(manifestPath)));
    await setTheme("ember");
    const text = Deno.readTextFileSync(cmux);
    assert(text.indexOf("font-size = 14") < text.indexOf("font-size = 18"), "ours stays before yours");
    assert(text.trimEnd().endsWith("font-size = 18"), text);
  } finally {
    s.restore();
  }
});

Deno.test("refreshing an old block you edited: left as is, said so, never doubled", async () => {
  const s = sandbox();
  try {
    const cmux = join(s.home, "config.ghostty");
    Deno.env.set("CC_STARSHIP_TERMINALS", cmux);
    await install("rainbow", { ...opts(s), components: { ...ALL_COMPONENTS, terminal: true } });
    const manifestPath = join(s.installDir, "manifest.json");
    Deno.writeTextFileSync(
      manifestPath,
      Deno.readTextFileSync(manifestPath).replaceAll("font-size = 14", "font-size = 15"),
    );
    Deno.writeTextFileSync(cmux, Deno.readTextFileSync(cmux).replace("font-size = 14", "font-size = 16"));
    const report = await setTheme("ember");
    const text = Deno.readTextFileSync(cmux);
    assertEquals(text.match(/cc-starship terminal >>>/g)?.length, 1);
    assertStringIncludes(text, "font-size = 16");
    assert(report.some((l) => l.includes("edited")), report.join("\n"));
  } finally {
    s.restore();
  }
});

Deno.test("settings.json with comments: a look switch changes nothing and says why", async () => {
  const s = sandbox();
  try {
    Deno.writeTextFileSync(s.zshrc, 'eval "$(starship init zsh)"\n');
    await install("rainbow", { ...opts(s), components: { ...ALL_COMPONENTS, shell: false, usage: false } });
    Deno.writeTextFileSync(s.settings, Deno.readTextFileSync(s.settings).replace("{", "{\n  // mine"));
    const files = [s.starship, s.settings, s.zshrc].map(sha);
    await assertRejects(() => setTheme("ember"), Error, "comments");
    assertEquals([s.starship, s.settings, s.zshrc].map(sha), files);
  } finally {
    s.restore();
  }
});

Deno.test("status bar off leaves a status line you set yourself afterwards alone", async () => {
  const s = sandbox();
  try {
    Deno.writeTextFileSync(s.settings, '{"statusLine": {"type": "command", "command": "node old.mjs"}}\n');
    await install("rainbow", { ...opts(s), components: { ...ALL_COMPONENTS, bar: false } });
    const data = JSON.parse(Deno.readTextFileSync(s.settings));
    data.statusLine = { type: "command", command: "my-new-bar" };
    Deno.writeTextFileSync(s.settings, JSON.stringify(data));
    await setTheme("ember");
    assertEquals(JSON.parse(Deno.readTextFileSync(s.settings)).statusLine.command, "my-new-bar");
    await uninstall();
    assertEquals(
      JSON.parse(Deno.readTextFileSync(s.settings)).statusLine?.command,
      "my-new-bar",
      "yours wins",
    );
  } finally {
    s.restore();
  }
});

Deno.test("a commented-out starship line doesn't count as starting Starship", async () => {
  const s = sandbox();
  try {
    Deno.writeTextFileSync(s.zshrc, '# eval "$(starship init zsh)"\n');
    await install("rainbow", { ...opts(s), components: { ...ALL_COMPONENTS, memory: false } });
    assertStringIncludes(
      Deno.readTextFileSync(s.zshrc),
      "# >>> cc-starship >>>",
      "our start-up line was added",
    );
    await setComponents({ ...ALL_COMPONENTS, shell: false, usage: false, memory: false });
    assert(!Deno.readTextFileSync(s.zshrc).includes("prompt off"), "nothing to switch off");
  } finally {
    s.restore();
  }
});

Deno.test("Windows Terminal: a font you pick later is kept on the next switch", async () => {
  const s = sandbox();
  try {
    const wt = join(s.home, "settings.json.wt.json");
    Deno.writeTextFileSync(wt, JSON.stringify(wtSettings, null, 4) + "\n");
    Deno.env.set("CC_STARSHIP_TERMINALS", wt);
    await install("rainbow", { ...opts(s), components: { ...ALL_COMPONENTS, terminal: true } });
    const data = JSON.parse(Deno.readTextFileSync(wt));
    data.profiles.defaults.font = { face: "Hack Nerd Font", size: 12 };
    Deno.writeTextFileSync(wt, JSON.stringify(data, null, 4) + "\n");
    await setTheme("ember");
    assertEquals(JSON.parse(Deno.readTextFileSync(wt)).profiles.defaults.font, {
      face: "Hack Nerd Font",
      size: 12,
    });
  } finally {
    s.restore();
  }
});

Deno.test("an empty profile list (a failed lookup) is never saved", async () => {
  const s = sandbox();
  try {
    Deno.env.delete("CC_STARSHIP_PROFILES");
    await install("rainbow", { ...opts(s), components: { ...ALL_COMPONENTS, memory: false } });
    const statePath = join(s.installDir, "state.json");
    Deno.writeTextFileSync(
      statePath,
      JSON.stringify({ ...JSON.parse(Deno.readTextFileSync(statePath)), profilePaths: [] }),
    );
    await setComponents({ ...ALL_COMPONENTS, memory: true });
    assertStringIncludes(Deno.readTextFileSync(s.zshrc), "cc-starship memory >>>", "found the profile again");
  } finally {
    s.restore();
  }
});

Deno.test("PowerShell, prompt off, memory on: the plain prompt still saves the last folder", async () => {
  const s = sandbox();
  try {
    const ps1 = join(s.home, "profile.ps1");
    const original = "Set-Alias ll Get-ChildItem\r\n";
    Deno.writeTextFileSync(ps1, original);
    Deno.env.set("CC_STARSHIP_PROFILES", ps1);
    const off = { ...ALL_COMPONENTS, shell: false, usage: false };
    await install("rainbow", { ...opts(s), components: off });
    const text = Deno.readTextFileSync(ps1);
    assertStringIncludes(text, "cc-starship memory >>>");
    assertStringIncludes(text, "cc-starship prompt off >>>", "a prompt that calls the folder saver");
    await setComponents({ ...off, memory: false });
    assertEquals(Deno.readTextFileSync(ps1), original, "neither block needed any more");
  } finally {
    s.restore();
  }
});

Deno.test("profile paths are looked up again in the background (a shell installed since is found)", async () => {
  const s = sandbox();
  try {
    Deno.env.delete("CC_STARSHIP_PROFILES");
    await install("rainbow", { ...opts(s), components: { ...ALL_COMPONENTS, memory: false } });
    const statePath = join(s.installDir, "state.json");
    const stale = { ...JSON.parse(Deno.readTextFileSync(statePath)), profilePaths: [join(s.home, "gone")] };
    Deno.writeTextFileSync(statePath, JSON.stringify(stale));
    await refreshProfilePaths();
    assertEquals(readInstalled()?.profilePaths, [s.zshrc]);
    assertEquals(readInstalled()?.theme, "rainbow", "the rest of the state kept");
  } finally {
    s.restore();
  }
});

/** A stand-in for Windows PowerShell's execution policy: `state` holds the CurrentUser value. */
function fakeWindowsPowerShell(home: string, currentUser: string): string {
  const state = join(home, "policy");
  Deno.writeTextFileSync(state, currentUser);
  const exe = join(home, "fake-powershell");
  Deno.writeTextFileSync(
    exe,
    `#!/bin/sh
case "$*" in
  *Set-ExecutionPolicy*) printf %s "$(echo "$*" | sed -E 's/.*-ExecutionPolicy ([A-Za-z]+).*/\\1/')" > "${state}";;
esac
cu=$(cat "${state}")
if [ "$cu" = Undefined ]; then echo Restricted; else echo "$cu"; fi
echo "$cu"
`,
  );
  Deno.chmodSync(exe, 0o755);
  Deno.env.set("CC_STARSHIP_WINPS", exe);
  return state;
}

Deno.test("Windows PowerShell that runs no scripts: allowed for your account, put back at uninstall", async () => {
  const s = sandbox();
  try {
    const ps1 = join(s.home, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1");
    Deno.mkdirSync(join(s.home, "Documents", "WindowsPowerShell"), { recursive: true });
    Deno.env.set("CC_STARSHIP_PROFILES", ps1);
    const policy = fakeWindowsPowerShell(s.home, "Undefined");
    const report = await install("rainbow", opts(s));
    assertEquals(Deno.readTextFileSync(policy), "RemoteSigned", "the profile can run");
    assert(report.some((l) => l.includes("RemoteSigned")), report.join("\n"));
    await setTheme("ember");
    await uninstall();
    assertEquals(Deno.readTextFileSync(policy), "Undefined", "put back");
  } finally {
    Deno.env.delete("CC_STARSHIP_WINPS");
    s.restore();
  }
});

Deno.test("Windows PowerShell that already runs scripts: its setting is never touched", async () => {
  const s = sandbox();
  try {
    const ps1 = join(s.home, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1");
    Deno.mkdirSync(join(s.home, "Documents", "WindowsPowerShell"), { recursive: true });
    Deno.env.set("CC_STARSHIP_PROFILES", ps1);
    const policy = fakeWindowsPowerShell(s.home, "Bypass");
    await install("rainbow", opts(s));
    assertEquals(Deno.readTextFileSync(policy), "Bypass");
    Deno.writeTextFileSync(policy, "Undefined"); // changed by you after install
    await uninstall();
    assertEquals(Deno.readTextFileSync(policy), "Undefined", "yours stays");
  } finally {
    Deno.env.delete("CC_STARSHIP_WINPS");
    s.restore();
  }
});

Deno.test("uninstall also removes the start-up caches our programs left in the temp folder", async () => {
  const s = sandbox();
  const tmp = join(s.home, "tmp");
  try {
    const ours = ["deno-compile-cc-starship.cache", "deno-compile-cc-starship-aarch64-apple-darwin.cache"];
    for (const f of [...ours, "deno-compile-other.cache"]) Deno.writeTextFileSync(join(tmp, f), "x");
    // In a process of its own: the removal happens after that process has exited.
    const script = join(s.home, "run.ts");
    const engine = new URL("../src/engine.ts", import.meta.url).href;
    Deno.writeTextFileSync(
      script,
      `import { install, uninstall } from "${engine}";\n` +
        `await install("rainbow", ${JSON.stringify(opts(s))});\nawait uninstall();\n`,
    );
    const run = await new Deno.Command(Deno.execPath(), { args: ["run", "-A", script] }).output();
    assert(run.success, new TextDecoder().decode(run.stderr));
    for (let i = 0; i < 40 && ours.some((f) => sha(join(tmp, f)) !== "missing"); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assertEquals([...Deno.readDirSync(tmp)].map((e) => e.name), ["deno-compile-other.cache"]);
  } finally {
    s.restore();
  }
});

Deno.test("uninstall removes the fonts this app installed (its record goes with the install folder)", async () => {
  const s = sandbox();
  try {
    await install("rainbow", opts(s));
    const font = join(s.home, "JetBrainsMonoNerdFont-Regular.ttf");
    const mine = join(s.home, "MyFont.ttf");
    Deno.writeTextFileSync(font, "font");
    Deno.writeTextFileSync(mine, "font");
    Deno.writeTextFileSync(
      join(s.installDir, "fonts.json"),
      JSON.stringify([{ id: "jetbrains", files: [font], registry: [] }]),
    );
    const report = await uninstall();
    assertEquals(sha(font), "missing");
    assert(sha(mine) !== "missing", "other fonts stay");
    assert(report.some((l) => l.includes("JetBrainsMono Nerd Font: removed")), report.join("\n"));
  } finally {
    s.restore();
  }
});

Deno.test("switching memory off, or uninstalling, points to the PowerShell history kept from before", async () => {
  const s = sandbox();
  const appData = Deno.env.get("APPDATA");
  try {
    const ps1 = join(s.home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1");
    Deno.env.set("CC_STARSHIP_PROFILES", ps1);
    Deno.env.set("APPDATA", join(s.home, "AppData"));
    const dir = join(s.home, "AppData", "Microsoft", "Windows", "PowerShell", "PSReadLine");
    Deno.mkdirSync(dir, { recursive: true });
    await install("rainbow", opts(s));
    const kept = join(dir, "ConsoleHost_history.txt.before-cc-starship");
    Deno.writeTextFileSync(kept, "ls\nls\n"); // what the profile saves before its first clean-up
    const report = await uninstall();
    assert(report.some((l) => l.includes(kept)), report.join("\n"));
    assert(sha(kept) !== "missing", "your history stays");
  } finally {
    appData === undefined ? Deno.env.delete("APPDATA") : Deno.env.set("APPDATA", appData);
    s.restore();
  }
});
