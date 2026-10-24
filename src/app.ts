// Steps shared by the command line and the keyboard picker.
import { basename, join } from "node:path";
import { type Components, install, runningFromInstallDir, shellProfiles, uninstall } from "./engine.ts";
import { ompNotes } from "./omp.ts";
import { detectNerdFonts, FONTS, installFont } from "./fonts.ts";
import { isWindows, paths, readState } from "./paths.ts";
import { TERMINAL_FONT } from "./terminal.ts";
import { barConfig, type Preset, shellConfig } from "./presets.ts";
import { downloadStarship, findStarship, latestVersion, runUpdate, updatePlan } from "./starship.ts";
import { renderBar } from "./statusline.ts";
import type { Clock, Language, Prefs } from "./when.ts";

export const VERSION = "0.1.0";
const compiled = basename(Deno.execPath()).startsWith("starship-statusline");

/** Claude Code's current statusLine setting, if readable. */
export function claudeStatusLine(): { command?: string } | undefined {
  try {
    return JSON.parse(Deno.readTextFileSync(paths.claudeSettings()).replace(/^\uFEFF/, "")).statusLine;
  } catch {
    return undefined;
  }
}

/** Uninstalls, reporting each step; returns an exit code. */
export async function runUninstall(log: (line: string) => void): Promise<number> {
  (await uninstall()).forEach(log);
  if (isWindows && runningFromInstallDir()) {
    log("the install folder is deleted as soon as this window closes");
  }
  return 0;
}

/** Makes sure a current Starship exists; returns its path. `log` reports each step. */
export async function ensureStarship(update: boolean, log: (line: string) => void): Promise<string> {
  let info = findStarship();
  let latest: string | null = null;
  try {
    latest = await latestVersion();
  } catch {
    log("could not reach GitHub to check for a newer Starship; keeping what is installed");
  }
  const plan = latest ? updatePlan(info, latest) : info ? null : { kind: "download" as const };
  if (plan && (update || !info)) {
    if (plan.kind === "command") {
      log(`updating Starship ${info?.version} → ${latest}: ${plan.command.join(" ")}`);
      if (!runUpdate(plan.command)) log("the update failed; keeping the installed Starship");
      info = findStarship();
    } else {
      log(
        info
          ? `downloading Starship ${latest} (installed: ${info.version})`
          : `downloading Starship ${latest}`,
      );
      const path = await downloadStarship();
      info = { path, version: latest, managedBy: "ours" };
    }
  }
  if (!info) throw new Error("Starship is not available");
  log(`Starship ${info.version ?? "?"}: ${info.path}`);
  return info.path;
}

export async function doInstall(
  presetId: string,
  update: boolean,
  log: (line: string) => void,
  components?: Components,
  prefs?: Prefs,
): Promise<void> {
  ompNotes(shellProfiles(), claudeStatusLine()).forEach((n) => log(`note: ${n}`));
  const starship = await ensureStarship(update, log);
  if (components?.terminal && !detectNerdFonts().includes(TERMINAL_FONT)) {
    log(`installing ${TERMINAL_FONT} for the terminal settings`);
    (await installFont(FONTS.find((f) => f.family === TERMINAL_FONT)!)).forEach(log);
  }
  const report = await install(presetId, {
    starship,
    bin: compiled ? paths.bin() : Deno.execPath(),
    copySelf: compiled,
    components,
    prefs,
  });
  report.forEach(log);
}

/** The preset's status bar (from a sample session) and shell prompt, as ANSI text. */
export function previewLines(
  preset: Preset,
  starship = readState()?.starship ?? "starship",
  prefs?: { language: Language; clock: Clock },
): string[] {
  const dir = Deno.makeTempDirSync({ prefix: "starship-statusline-preview-" });
  try {
    const bar = join(dir, "bar.toml"), shell = join(dir, "shell.toml");
    Deno.writeTextFileSync(bar, barConfig(preset));
    Deno.writeTextFileSync(shell, shellConfig(preset, Deno.execPath()));
    const sample = samplePayload();
    // The bar saves the sample's 5h/7d usage here, and the prompt's usage segment reads it back.
    const barText = renderBar(sample, {
      preset,
      configPath: bar,
      starship,
      accountEmail: "you@example.com",
      usageFile: join(dir, "usage"),
      prefs,
    });
    const prompt = new Deno.Command(starship, {
      args: ["prompt", "--cmd-duration", "1233000"],
      cwd: sample.workspace.current_dir,
      env: { STARSHIP_CONFIG: shell, STARSHIP_SHELL: "", STARSHIP_STATUSLINE_HOME: dir },
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    const promptLine = new TextDecoder().decode(prompt.stdout).split("\n").find((l) => l.trim()) ?? "";
    return [...barText.trimEnd().split("\n"), promptLine];
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

function samplePayload() {
  const now = Math.floor(Date.now() / 1000);
  return {
    model: { display_name: "Opus 5.5" },
    version: "2.1.310",
    effort: { level: "medium" },
    workspace: { current_dir: Deno.cwd() },
    cost: {
      total_cost_usd: 1.23,
      total_lines_added: 156,
      total_lines_removed: 23,
      total_duration_ms: 8460000,
    },
    context_window: { used_percentage: 34, total_input_tokens: 68000 },
    rate_limits: {
      five_hour: { used_percentage: 42, resets_at: now + 5400 },
      seven_day: { used_percentage: 23, resets_at: now + 3 * 86400 },
    },
  };
}
