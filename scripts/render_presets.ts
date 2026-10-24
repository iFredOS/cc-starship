// Prints presets as they render: name, the status bar (from fixture.json, with a
// warning-level context so amber/red show) and the shell prompt.
// Usage: deno run -A scripts/render_presets.ts [first] [count]
import { join } from "node:path";
import { allPresets, barConfig, shellConfig } from "../src/presets.ts";
import { renderBar } from "../src/statusline.ts";

const [first = 0, count = 99] = Deno.args.map(Number);
const fixture = JSON.parse(Deno.readTextFileSync(new URL("../fixture.json", import.meta.url)));
fixture.context_window.used_percentage = 92;
fixture.rate_limits.five_hour.used_percentage = 74;
fixture.prompt_cache = {
  caching_observed: true,
  warm: true,
  expires_at: Math.floor(Date.now() / 1000) + 42 * 60,
};
const dir = Deno.makeTempDirSync();
// Stand-in for the installed binary's `usage` command, so the shell shows that segment.
const usageStub = join(dir, "usage-stub");
Deno.writeTextFileSync(usageStub, "#!/bin/sh\nprintf '✻ 5h 4%% · 7d 23%%'\n");
Deno.chmodSync(usageStub, 0o755);

allPresets().slice(first, first + count).forEach((p, i) => {
  const bar = join(dir, "bar.toml"), shell = join(dir, "shell.toml");
  Deno.writeTextFileSync(bar, barConfig(p));
  Deno.writeTextFileSync(shell, shellConfig(p, usageStub));
  const prompt = new Deno.Command("starship", {
    // A 20m33s last command, so the duration segment shows too.
    args: ["prompt", "--cmd-duration", "1233000"],
    cwd: fixture.workspace.current_dir,
    env: { STARSHIP_CONFIG: shell, STARSHIP_SHELL: "" },
  }).outputSync();
  console.log(`\x1b[1m${first + i + 1}. ${p.name}\x1b[0m  (${p.id})`);
  console.log(
    renderBar(fixture, { preset: p, configPath: bar, starship: "starship", accountEmail: "you@example.com" }),
  );
  // Starship starts with a blank line (add_newline); show the prompt line itself.
  console.log(new TextDecoder().decode(prompt.stdout).split("\n").find((l) => l.trim()) ?? "");
});
