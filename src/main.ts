// starship-statusline: installer, uninstaller and runtime for a Starship-rendered
// Claude Code status bar and matching shell prompt.
import { doInstall, previewLines, runUninstall, VERSION } from "./app.ts";
import { setTheme } from "./engine.ts";
import { paths, readState } from "./paths.ts";
import { allPresets, DEFAULT_PRESET, findPreset } from "./presets.ts";
import { findStarship } from "./starship.ts";
import { readAccountEmail, renderBar } from "./statusline.ts";
import { runUi } from "./tui.ts";
import { usageText } from "./usage.ts";

const HELP = `starship-statusline ${VERSION}
Claude Code status bar and shell prompt, rendered by Starship.

  starship-statusline                  pick a preset with the keyboard and install it
  starship-statusline install [--preset NAME] [--no-starship-update]
  starship-statusline uninstall        put back everything the installer changed
  starship-statusline theme [NAME]     switch preset (prompt and status bar), or show the current one
  starship-statusline presets          list presets
  starship-statusline preview [NAME]   print a preset's status bar and shell prompt
  starship-statusline statusline       (run by Claude Code) render the status bar from stdin
  starship-statusline usage            (run by the shell prompt) print Claude usage`;

async function statusline(): Promise<void> {
  const text = await new Response(Deno.stdin.readable).text();
  let payload = {};
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
    case "usage":
      await Deno.stdout.write(new TextEncoder().encode(usageText(paths.usage())));
      return 0;
    case "install": {
      const preset = flag(args, "--preset") ?? readState()?.theme ?? DEFAULT_PRESET;
      await doInstall(preset, !args.includes("--no-starship-update"), log);
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
    case "preview": {
      const preset = findPreset(args[1] ?? readState()?.theme ?? DEFAULT_PRESET);
      if (!preset) throw new Error(`unknown preset "${args[1]}"`);
      console.log(previewLines(preset, findStarship()?.path ?? "starship").join("\n"));
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
    console.error(`starship-statusline: ${e instanceof Error ? e.message : e}`);
    Deno.exit(1);
  }
}
