// cc-starship: installer, uninstaller and runtime for a Starship-rendered
// Claude Code status bar and matching shell prompt.
import { claudeStatusLine, doInstall, ensureStarship, previewLines, runUninstall, VERSION } from "./app.ts";
import {
  ALL_COMPONENTS,
  type Components,
  readInstalled,
  setComponents,
  setPrefs,
  setTheme,
  shellProfiles,
} from "./engine.ts";
import {
  detectNerdFonts,
  fontFamilies,
  FONTS,
  installedByUs,
  installFont,
  uninstallFont,
  windowsTerminalSettings,
} from "./fonts.ts";
import { HOOK_COST, hookOutput, pruneSnapshots, snapshotFile } from "./hook.ts";
import { ompNotes } from "./omp.ts";
import { paths, readState } from "./paths.ts";
import { allPresets, DEFAULT_PRESET, findPreset } from "./presets.ts";
import {
  findStarship,
  latestVersion,
  type Manager,
  runUpdate,
  uninstallPlan,
  updatePlan,
} from "./starship.ts";
import { readAccountEmail, renderBar } from "./statusline.ts";
import { runUi } from "./tui.ts";
import { usageText } from "./usage.ts";
import { DEFAULT_HOOK_FROM, DEFAULT_PREFS, HOOK_FROM_CHOICES, type Prefs, resolvePrefs } from "./when.ts";

const HELP = `cc-starship ${VERSION}
Claude Code status bar and shell prompt, rendered by Starship.

  cc-starship                  pick a preset with the keyboard and install it
  cc-starship install [--preset NAME] [--no-starship-update] [--no-hook]
  cc-starship uninstall        put back everything the installer changed
  cc-starship theme [NAME]     switch preset (prompt and status bar), or show the current one
  cc-starship presets          list presets
  cc-starship preview [NAME]   print a preset's status bar and shell prompt
  cc-starship status           what is installed: parts, Starship, Nerd Fonts
  cc-starship components [bar|shell|usage|hook|memory|terminal] [on|off]
  cc-starship font list | install ID | remove ID
  cc-starship starship update | remove
  cc-starship prefs [language auto|en|fr-CA] [clock auto|24h|12h] [hook-from 0|50|70|90]
  cc-starship statusline       (run by Claude Code) render the status bar from stdin
  cc-starship usage            (run by the shell prompt) print Claude usage
  cc-starship hook             (run by Claude Code) tell Claude its usage with each prompt`;

/** How Starship got there, for `status`. */
const HOW: Record<Manager, string> = {
  brew: "via brew",
  winget: "via winget",
  scoop: "via Scoop",
  ours: "downloaded by cc-starship",
  unknown: "installed by hand",
};

async function status(): Promise<number> {
  const state = readInstalled();
  const info = findStarship();
  let latest: string | null = null;
  try {
    latest = await latestVersion();
  } catch {
    // offline
  }
  const on = (b: boolean) => (b ? "on" : "off");
  console.log(`installed:  ${state ? `yes, ${findPreset(state.theme)?.name}` : "no"}`);
  if (state) {
    const c = state.components;
    console.log(
      `parts:      status bar ${on(c.bar)}, shell prompt ${on(c.shell)}, usage ${on(c.usage)}, ` +
        `usage for Claude ${on(c.hook)}, shell memory ${on(c.memory)}, terminal settings ${on(c.terminal)}`,
    );
  }
  const update = info && latest && updatePlan(info, latest) ? ` (update to ${latest} available)` : "";
  console.log(
    `starship:   ${info ? `${info.version} ${HOW[info.managedBy]}, ${info.path}${update}` : "not found"}`,
  );
  console.log(`nerd fonts: ${fontFamilies(detectNerdFonts()).join(", ") || "none found"}`);
  for (const note of ompNotes(shellProfiles(state ?? undefined), claudeStatusLine())) {
    console.log(`note:       ${note}`);
  }
  const wt = windowsTerminalSettings();
  if (wt) {
    let plain = true;
    try {
      JSON.parse(Deno.readTextFileSync(wt).replace(/^﻿/, ""));
    } catch {
      plain = false;
    }
    console.log(
      `terminal:   Windows Terminal, ${
        plain ? "font can be set automatically" : "settings have comments: set the font by hand"
      }`,
    );
  }
  return 0;
}

async function prefsCommand(args: string[]): Promise<number> {
  const state = readInstalled();
  if (!state) throw new Error("not installed yet: run install first");
  const prefs: Prefs = { ...state.prefs };
  for (let i = 0; i < args.length; i += 2) {
    const [key, value] = [args[i], args[i + 1]];
    if (key === "language" && ["auto", "en", "fr-CA"].includes(value)) {
      prefs.language = value as Prefs["language"];
    } else if (key === "clock" && ["auto", "24h", "12h"].includes(value)) {
      prefs.clock = value as Prefs["clock"];
    } else if (key === "hook-from" && HOOK_FROM_CHOICES.includes(Number(value) as 0)) {
      prefs.hookFrom = Number(value);
    } else {throw new Error(
        "usage: prefs [language auto|en|fr-CA] [clock auto|24h|12h] [hook-from 0|50|70|90]",
      );}
  }
  if (args.length) await setPrefs(prefs);
  const r = resolvePrefs(prefs);
  const from = prefs.hookFrom ?? DEFAULT_HOOK_FROM;
  console.log(
    `language ${prefs.language} (${r.language}), clock ${prefs.clock} (${r.clock}), ` +
      `usage to Claude ${from ? `from ${from}%` : "every prompt"}`,
  );
  return 0;
}

async function componentsCommand(args: string[]): Promise<number> {
  const state = readInstalled();
  if (!state) throw new Error("not installed yet: run install first");
  const [name, value] = args;
  if (!name) {
    console.log(JSON.stringify(state.components));
    return 0;
  }
  if (
    !["bar", "shell", "usage", "hook", "memory", "terminal"].includes(name) || !["on", "off"].includes(value)
  ) {
    throw new Error("usage: components bar|shell|usage|hook|memory|terminal on|off");
  }
  const next: Components = { ...state.components, [name]: value === "on" };
  if (name === "hook" && value === "on") console.log(`Usage for Claude: ${HOOK_COST}.`);
  (await setComponents(next)).forEach((l) => console.log(`  ${l}`));
  return 0;
}

async function fontCommand(args: string[], log: (l: string) => void): Promise<number> {
  const [action, id] = args;
  if (!action || action === "list") {
    const found = detectNerdFonts();
    const ours = installedByUs().map((r) => r.id);
    for (const f of FONTS) {
      const mark = found.includes(f.family)
        ? (ours.includes(f.id) ? "installed by this app" : "installed")
        : "";
      console.log(`${f.id.padEnd(10)} ${f.family.padEnd(26)} ${mark}`);
    }
    return 0;
  }
  const font = FONTS.find((f) => f.id === id);
  if (!font) throw new Error(`unknown font "${id}" (see: font list)`);
  if (action === "install") (await installFont(font)).forEach(log);
  else if (action === "remove") uninstallFont(font.id).forEach(log);
  else throw new Error("usage: font list | install ID | remove ID");
  return 0;
}

async function starshipCommand(action: string | undefined, log: (l: string) => void): Promise<number> {
  if (action === "update") {
    await ensureStarship(true, log);
    return 0;
  }
  if (action === "remove") {
    const info = findStarship();
    if (!info) throw new Error("Starship isn't installed");
    const plan = uninstallPlan(info);
    if (!plan) {
      throw new Error(`${info.path} wasn't installed by a known package manager; remove it yourself`);
    }
    if (plan.kind === "delete") Deno.removeSync(plan.path);
    else if (!runUpdate(plan.command)) return 1;
    log(`removed Starship (${info.path})`);
    return 0;
  }
  throw new Error("usage: starship update | remove");
}

async function statusline(): Promise<void> {
  const text = await new Response(Deno.stdin.readable).text();
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(text);
  } catch {
    // render with defaults
  }
  const state = readState();
  const preset = findPreset(state?.theme ?? DEFAULT_PRESET) ?? findPreset(DEFAULT_PRESET)!;
  const columns = Number(Deno.env.get("COLUMNS")) || undefined;
  const out = renderBar(payload, {
    preset,
    configPath: paths.barConfig(),
    starship: state?.starship ?? "starship",
    columns,
    accountEmail: readAccountEmail(paths.claudeAccount()),
    usageFile: paths.usage(),
    snapshotFile: "session_id" in payload
      ? snapshotFile(paths.sessions(), String(payload.session_id))
      : undefined,
    prefs: resolvePrefs(readInstalled()?.prefs ?? DEFAULT_PREFS),
  });
  await Deno.stdout.write(new TextEncoder().encode(out));
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function main(args: string[]): Promise<number> {
  const log = (line: string) => console.log(`  ${line}`);
  switch (args[0]) {
    case undefined:
      if (!Deno.stdin.isTerminal()) {
        console.log(HELP);
        return 0;
      }
      return await runUi();
    case "statusline":
      await statusline();
      return 0;
    case "hook": {
      const input = await new Response(Deno.stdin.readable).text();
      const prefs = readInstalled()?.prefs ?? DEFAULT_PREFS;
      const out = hookOutput(input, {
        sessions: paths.sessions(),
        usageFile: paths.usage(),
        prefs: resolvePrefs(prefs),
        from: prefs.hookFrom ?? DEFAULT_HOOK_FROM,
      });
      if (out) await Deno.stdout.write(new TextEncoder().encode(out + "\n"));
      pruneSnapshots(paths.sessions());
      return 0;
    }
    case "usage":
      await Deno.stdout.write(new TextEncoder().encode(usageText(paths.usage())));
      return 0;
    case "install": {
      const preset = flag(args, "--preset") ?? readState()?.theme ?? DEFAULT_PRESET;
      const components = { ...(readInstalled()?.components ?? ALL_COMPONENTS) };
      if (args.includes("--no-hook")) components.hook = false;
      if (components.hook) {
        console.log(`Usage for Claude is on: ${HOOK_COST}. Install with --no-hook to leave it off.`);
      }
      await doInstall(preset, !args.includes("--no-starship-update"), log, components);
      console.log(
        `Installed with the ${findPreset(preset)?.name} preset. Open a new terminal tab to see it.`,
      );
      return 0;
    }
    case "uninstall": {
      const code = await runUninstall(log);
      if (code === 0) console.log("Uninstalled.");
      return code;
    }
    case "theme":
      if (!args[1]) {
        console.log(readState()?.theme ?? "(not installed)");
        return 0;
      }
      await setTheme(args[1]);
      console.log(
        `${findPreset(args[1])!.name}: new shell tabs and the next status bar refresh will use it.`,
      );
      return 0;
    case "presets":
      for (const p of allPresets()) console.log(`${p.id.padEnd(18)} ${p.name}`);
      return 0;
    case "status":
      return await status();
    case "prefs":
      return await prefsCommand(args.slice(1));
    case "components":
      return await componentsCommand(args.slice(1));
    case "font":
      return await fontCommand(args.slice(1), log);
    case "starship":
      return await starshipCommand(args[1], log);
    case "preview": {
      const preset = findPreset(args[1] ?? readState()?.theme ?? DEFAULT_PRESET);
      if (!preset) throw new Error(`unknown preset "${args[1]}"`);
      const prefs = resolvePrefs(readInstalled()?.prefs ?? DEFAULT_PREFS);
      console.log(previewLines(preset, findStarship()?.path ?? "starship", prefs).join("\n"));
      return 0;
    }
    case "--version":
    case "version":
      console.log(VERSION);
      return 0;
    default:
      console.log(HELP);
      return args[0] === "help" || args[0] === "--help" || args[0] === "-h" ? 0 : 2;
  }
}

if (import.meta.main) {
  try {
    Deno.exit(await main(Deno.args));
  } catch (e) {
    console.error(`cc-starship: ${e instanceof Error ? e.message : e}`);
    Deno.exit(1);
  }
}
