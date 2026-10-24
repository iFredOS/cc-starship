import { join } from "node:path";
import { barConfig, findPreset, type Preset } from "../src/presets.ts";
import { type BarOptions, renderBar } from "../src/statusline.ts";

export const fixture = JSON.parse(
  Deno.readTextFileSync(new URL("../fixture.json", import.meta.url)),
);

// deno-lint-ignore no-control-regex -- matches ANSI color codes
export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

export function tempDir(): string {
  return Deno.makeTempDirSync({ prefix: "cc-starship-test-" });
}

/** Renders the bar for `payload` with `presetId`, in a throwaway config dir. */
export function bar(
  payload: unknown,
  opts: {
    preset?: string;
    columns?: number;
    email?: string;
    usageFile?: string;
    prefs?: BarOptions["prefs"];
  } = {},
): string {
  return barWith(findPreset(opts.preset ?? "fusain") as Preset, payload, opts);
}

/** Like `bar`, with a preset object (for presets that don't ship). */
export function barWith(
  preset: Preset,
  payload: unknown,
  opts: { columns?: number; email?: string; usageFile?: string; prefs?: BarOptions["prefs"] } = {},
): string {
  const dir = tempDir();
  const configPath = join(dir, "statusline.toml");
  Deno.writeTextFileSync(configPath, barConfig(preset));
  try {
    return renderBar(payload as Record<string, unknown>, {
      preset,
      configPath,
      starship: "starship",
      columns: opts.columns,
      accountEmail: opts.email ?? "you@example.com",
      usageFile: opts.usageFile ?? join(dir, "usage"),
      prefs: opts.prefs,
    });
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
}

export const plain = (payload: unknown, opts: Parameters<typeof bar>[1] = {}) =>
  stripAnsi(bar(payload, opts));

export const now = () => Math.floor(Date.now() / 1000);

/** Runs git in `cwd` with a throwaway identity. */
export function git(cwd: string, ...args: string[]): Deno.CommandOutput {
  return new Deno.Command("git", {
    args: ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    cwd,
  })
    .outputSync();
}

export function payload(extra: Record<string, unknown> = {}, dir = Deno.makeTempDirSync()) {
  return { model: { display_name: "Opus 5.5" }, workspace: { current_dir: dir }, ...extra };
}
