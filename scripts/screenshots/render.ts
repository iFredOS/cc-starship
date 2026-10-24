// Writes ANSI files for the README shots: warning chips, a narrow window, and a preset gallery.
import { join } from "node:path";
import { allPresets, barConfig, findPreset } from "../../src/presets.ts";
import { renderBar } from "../../src/statusline.ts";
const [out, app] = Deno.args;
const now = Math.floor(Date.now() / 1000);
const payload = (ctx: number, five: number) => ({
  model: { display_name: "Opus 5.5" },
  version: "2.1.310",
  effort: { level: "high" },
  workspace: { current_dir: app },
  cost: { total_cost_usd: 4.87, total_lines_added: 312, total_lines_removed: 48, total_duration_ms: 5520000 },
  context_window: { used_percentage: ctx, total_input_tokens: 184000 },
  rate_limits: {
    five_hour: { used_percentage: five, resets_at: now + 4200 },
    seven_day: { used_percentage: 38, resets_at: now + 2 * 86400 },
  },
});
const prefs = { language: "en", clock: "12h" } as const;
const render = (id: string, j: unknown, columns?: number) => {
  const preset = findPreset(id)!;
  const cfg = join(out, `bar-${id}.toml`);
  Deno.writeTextFileSync(cfg, barConfig(preset));
  return renderBar(j as Record<string, unknown>, {
    preset,
    configPath: cfg,
    starship: "starship",
    columns,
    accountEmail: "you@example.com",
    prefs,
  });
};
Deno.writeTextFileSync(join(out, "warn.ansi"), render("rainbow", payload(92, 74)));
Deno.writeTextFileSync(join(out, "narrow.ansi"), render("rainbow", payload(41, 22), 62));
for (const p of allPresets()) {
  Deno.writeTextFileSync(join(out, `gal-${p.id}.ansi`), render(p.id, payload(41, 22)));
}
console.log(allPresets().map((p) => `${p.id}=${p.name}`).join(" "));
