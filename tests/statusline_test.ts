import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import { contrast, mix } from "../src/color.ts";
import { allPresets, findPreset } from "../src/presets.ts";
import { buildBar, chipFor } from "../src/statusline.ts";
import { formatWhen } from "../src/when.ts";
import { bar, barWith, fixture, git, now, payload, plain, stripAnsi, tempDir } from "./helpers.ts";

const CAP_START = "\ue0b6", ARROW = "\ue0b0", CAP_END = "\ue0b4";
const rgb = (hex: string) => hex.match(/\w\w/g)!.map((h) => parseInt(h, 16)).join(";");

Deno.test("full payload shows every segment", () => {
  const out = plain(fixture);
  for (
    const s of [
      "✻ Opus 5.5",
      "◐ Medium",
      "\uf02b v2.1.290",
      "\uf007 you@example.com",
      "\uf07b /tmp",
      "\uf440 +156/−23 · \uf017 2h21m",
      "\uf1c0 CTX \u{e0b0} 8% \u{e0b0} / 15.5K ($1.23)",
      "\uf252 5h \u{e0b0} 42% \u{e0b0}",
      "\uf073 7d \u{e0b0} 13% \u{e0b0}",
    ]
  ) assertStringIncludes(out, s);
  const lines = out.split("\n");
  assertEquals(lines.length, 3);
  for (const line of lines) {
    assert(line.startsWith(CAP_START) && line.includes(ARROW) && line.trimEnd().endsWith(CAP_END), line);
  }
});

Deno.test("minimal payload keeps caps and hides optional segments", () => {
  const out = plain(payload(), { email: "" });
  assertStringIncludes(out, "✻ Opus 5.5");
  assertStringIncludes(out, "CTX \u{e0b0} 0% \u{e0b0} / 0 ($0.00)");
  for (const s of ["5h", "◐", "undefined", "NaN", "\uf007"]) assert(!out.includes(s), s);
  for (const line of out.split("\n")) {
    assert(line.startsWith(CAP_START) && line.trimEnd().endsWith(CAP_END), line);
  }
});

Deno.test("model names lose the context suffix", () => {
  const out = plain({ model: { display_name: "Opus 4.7 (1M context)" } });
  assertStringIncludes(out, "✻ Opus 4.7 ");
  assert(!out.includes("context"));
});

Deno.test("reset times follow the chosen language and clock", () => {
  const soon = now() + 2 * 3600, later = now() + 3 * 86400;
  const limits = payload({
    rate_limits: {
      five_hour: { used_percentage: 1, resets_at: soon },
      seven_day: { used_percentage: 23, resets_at: later },
    },
  });
  for (const prefs of [{ language: "en", clock: "12h" }, { language: "fr-CA", clock: "24h" }] as const) {
    const out = plain(limits, { prefs });
    const when = (t: number) => formatWhen(new Date(t * 1000), new Date(), prefs);
    assertStringIncludes(out, `5h \u{e0b0} 1% \u{e0b0} ${when(soon)}`);
    assertStringIncludes(out, `7d \u{e0b0} 23% \u{e0b0} ${when(later)}`);
  }
});

Deno.test("a spent 5-hour window reads Extra", () => {
  const out = plain(
    payload({ rate_limits: { five_hour: { used_percentage: 100 }, seven_day: { used_percentage: 40 } } }),
  );
  assertStringIncludes(out, "\uf252 5h \uf071 Extra");
});

Deno.test("70%+ shows an amber chip, 90%+ a red chip with ▲, then the segment colors return", () => {
  const out = bar(
    payload({
      context_window: { used_percentage: 95 },
      rate_limits: { five_hour: { used_percentage: 75 }, seven_day: { used_percentage: 10 } },
    }),
    { preset: "fusain" },
  );
  const gray = JSON.parse(Deno.readTextFileSync(new URL("../presets/presets.json", import.meta.url)))
    .find((p: { id: string }) => p.id === "fusain");
  const seg = gray.bar.lines[2][0];
  // Right-pointing arrows at both ends: segment into chip, then chip back into the segment.
  const chip = (bg: string, text: string, segBg: string) =>
    `\x1b[48;2;${rgb(bg)}m\x1b[38;2;${rgb(segBg)}m\u{e0b0}\x1b[38;2;${
      rgb("#1d2021")
    }m\x1b[1m ${text} \x1b[22m` +
    `\x1b[48;2;${rgb(segBg)}m\x1b[38;2;${rgb(bg)}m\u{e0b0}`;
  assertStringIncludes(out, chip("#fb4934", "▲95%", seg.bg));
  assertStringIncludes(out, chip("#fabd2f", "75%", gray.bar.lines[2][1].bg));
  assert(!out.includes(`${rgb("#fabd2f")}m\x1b[38;2;${rgb("#1d2021")}m\x1b[1m 10%`));
  // After the red chip, the context segment's own background and text color come back.
  assertStringIncludes(out, `\u{e0b0}\x1b[48;2;${rgb(seg.bg)}m\x1b[38;2;${rgb(seg.fg)}m`);
  assertStringIncludes(stripAnsi(out), "CTX \u{e0b0} ▲95% \u{e0b0} / ");
});

Deno.test("accent icons fall back to the segment text when they'd be hard to see", () => {
  const gray = JSON.parse(Deno.readTextFileSync(new URL("../presets/presets.json", import.meta.url)))
    .find((p: { id: string }) => p.id === "fusain");
  const seg = gray.bar.lines[0][0];
  // An accent equal to the model segment's background would be invisible.
  const out = barWith({ ...gray, bar: { ...gray.bar, accent: seg.bg } }, fixture);
  assert(!out.includes(`\x1b[38;2;${rgb(seg.bg)}m✻`), "accent not used");
  assertStringIncludes(out, `\x1b[38;2;${rgb(seg.fg)}m✻`);
});

Deno.test("no branch placeholder outside a repository", () => {
  const out = plain(payload());
  assert(!out.includes("─"), out);
  for (const line of out.split("\n")) assert(line.trimEnd().endsWith(CAP_END), line);
});

Deno.test("branch shows ahead/behind and dirty marks", () => {
  const repo = tempDir();
  git(repo, "init", "-q", "-b", "main");
  Deno.writeTextFileSync(join(repo, "f"), "hi");
  git(repo, "add", "f");
  git(repo, "commit", "-qm", "init");
  Deno.writeTextFileSync(join(repo, "f"), "bye");
  assertStringIncludes(plain(payload({}, repo)), "\ue725 main *");
});

Deno.test("no prompt cache timer, even when Claude Code sends cache data", () => {
  const out = plain(
    payload({ prompt_cache: { caching_observed: true, warm: true, expires_at: now() + 600 } }),
  );
  assert(!out.includes("\u{f06d}") && !out.includes("\u{f2dc}"), out);
});

Deno.test("worktrees show their name, not the derived branch", () => {
  const out = plain({
    model: { display_name: "Opus 5.5" },
    workspace: { current_dir: tempDir(), git_worktree: "feature-xyz" },
    worktree: { name: "feature-xyz", branch: "worktree-feature-xyz" },
  });
  assertStringIncludes(out, "\u{f0645} feature-xyz");
  assert(!out.includes("worktree-feature-xyz"));
  const long = "add-a-very-long-worktree-name-for-testing";
  const out2 = plain({
    model: { display_name: "x" },
    workspace: { current_dir: tempDir(), git_worktree: long },
  });
  assertStringIncludes(out2, "…");
  assert(!out2.includes(long));
});

Deno.test("narrow terminals: every line fits, essentials stay", () => {
  for (const columns of [60, 45]) {
    const out = plain(fixture, { columns });
    for (const line of out.split("\n")) assert([...line].length <= columns, `${columns}: ${line}`);
    assertStringIncludes(out, "✻ Opus 5.5");
    assertStringIncludes(out, "CTX \u{e0b0} 8% \u{e0b0}");
  }
  assert(!plain(fixture, { columns: 45 }).includes("you@example.com"));
  assertStringIncludes(plain(fixture, { columns: 200 }), "you@example.com");
});

Deno.test("each segment uses its preset text color", () => {
  // Ember's model segment: gold text on dark brown.
  const out = bar(fixture, { preset: "ember" });
  assertStringIncludes(out, `48;2;${rgb("#2e2018")}`);
  assertStringIncludes(out, `38;2;${rgb("#ffca63")}`);
  assert(stripAnsi(out).includes("✻ Opus 5.5"));
});

/** A real repo on main with a linked worktree beside it, on its own branch. */
function realWorktree() {
  const root = Deno.realPathSync(tempDir());
  const repo = join(root, "app"), wt = join(root, "app-login");
  Deno.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  Deno.writeTextFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  git(repo, "worktree", "add", "-q", "-b", "login-form", wt);
  return { root, repo, wt };
}

/** Line 2 of the bar for a session in `dir` (`extra` goes into `workspace`). */
const line2 = (dir: string, extra: Record<string, unknown> = {}, columns?: number) =>
  plain({ model: { display_name: "x" }, workspace: { current_dir: dir, ...extra } }, { columns }).split(
    "\n",
  )[1];

Deno.test("real worktree, as Claude Code reports it (--worktree / EnterWorktree)", () => {
  const { wt } = realWorktree();
  // The worktree's name, then its real branch (not one Claude Code derived from the name).
  assertStringIncludes(line2(wt, { git_worktree: "app-login" }), "\u{f0645} app-login \u{e725} login-form");
});

Deno.test("real worktree that Claude Code doesn't flag: its own branch still shows", () => {
  const { repo, wt } = realWorktree();
  assertStringIncludes(line2(wt), "login-form");
  const main = line2(repo);
  assertStringIncludes(main, "\u{e725} main");
  assert(!main.includes("login-form"), "the main checkout shows main");
});

/** realWorktree() plus a second linked worktree, and a stale one whose folder is gone. */
function worktreeFamily() {
  const { root, repo, wt } = realWorktree();
  const stale = join(root, "app-old");
  git(repo, "worktree", "add", "-q", "-b", "docs", join(root, "app-docs"));
  git(repo, "worktree", "add", "-q", "-b", "old", stale);
  Deno.removeSync(stale, { recursive: true }); // what git calls "prunable"
  return { repo, wt };
}

Deno.test("other worktrees: counted from the main checkout, stale ones ignored", () => {
  const { repo } = worktreeFamily();
  assertStringIncludes(line2(repo), "main · \u{f0645} 2 more");
});

Deno.test("other worktrees: inside one, the main checkout counts too", () => {
  const { wt } = worktreeFamily();
  const out = line2(wt, { git_worktree: "app-login" });
  assertStringIncludes(out, "\u{f0645} app-login \u{e725} login-form · \u{f0645} 2 more");
});

Deno.test("other worktrees: found from a subfolder; nothing shown when there are none", () => {
  const { repo } = worktreeFamily();
  Deno.mkdirSync(join(repo, "src"));
  assertStringIncludes(line2(join(repo, "src")), "2 more");
  const lone = Deno.realPathSync(tempDir());
  git(lone, "init", "-q", "-b", "main");
  const out = line2(lone);
  assert(!out.includes("more"), out);
});

Deno.test("other worktrees: the count is the first thing a narrow window drops", () => {
  const { repo } = worktreeFamily();
  const wide = line2(repo);
  const columns = [...wide].length; // just too narrow for the full line (plus the bar's margin)
  const narrow = line2(repo, {}, columns);
  assert(!narrow.includes("more"), narrow);
  assertStringIncludes(narrow, "\u{e725} main");
});

Deno.test("a git status worked out once can be passed in (previews of every look reuse it)", () => {
  const out = plain(payload(), { git: { name: "from-cache", marks: " *" } });
  assertStringIncludes(out, "\u{e725} from-cache *");
});

Deno.test("status bar: a newer cc-starship shows at the end of line 3, and is the first thing a narrow window drops", () => {
  const base = {
    preset: findPreset("fusain")!,
    configPath: "",
    starship: "",
    git: { name: "main", marks: "" },
  };
  const wide = buildBar(fixture, { ...base, update: "1.0.2" }).vars;
  assertStringIncludes(wide.CC_L3_4, "cc-starship 1.0.2");
  assertEquals(wide.CC_L3_END4, "1");
  assertEquals(buildBar(fixture, base).vars.CC_L3_4, undefined, "nothing without an update");
  const line3 = (v: Record<string, string>) => Object.entries(v).filter(([k]) => k.startsWith("CC_L3_"));
  for (const columns of [70, 60, 50]) {
    const narrow = buildBar(fixture, { ...base, columns, update: "1.0.2" }).vars;
    const without = buildBar(fixture, { ...base, columns }).vars;
    if (!narrow.CC_L3_4) {
      assertEquals(line3(narrow), line3(without), `${columns}: dropped before anything else`);
    }
  }
  assert(!buildBar(fixture, { ...base, columns: 50, update: "1.0.2" }).vars.CC_L3_4?.includes("cc-starship"));
});

Deno.test("a chip keeps its amber or red on a segment where that stands out", () => {
  assertEquals(chipFor("warn", "#32302f"), { bg: "#fabd2f", fg: "#1d2021" });
  assertEquals(chipFor("crit", "#32302f"), { bg: "#fb4934", fg: "#1d2021" });
});

Deno.test("where amber or red would vanish into the segment, the chip is a deep shade of it", () => {
  // Nord's 5h segment is itself yellow: #ebcb8b at 30%.
  assertEquals(chipFor("warn", "#ebcb8b"), { bg: "#473d2a", fg: "#fabd2f" });
  assertEquals(chipFor("crit", "#f04a38"), { bg: "#481611", fg: "#fb4934" });
});

Deno.test("in every look, every segment of line 3 shows its warning chips", () => {
  for (const p of allPresets()) {
    for (const [slot, { bg }] of p.bar.lines[2].entries()) {
      for (const level of ["warn", "crit"] as const) {
        const chip = chipFor(level, bg);
        const edge = contrast(chip.bg, bg), text = contrast(chip.fg, chip.bg);
        assert(edge >= 1.5, `${p.id} slot ${slot} ${level}: chip vs segment ${edge.toFixed(2)}`);
        assert(text >= 4, `${p.id} slot ${slot} ${level}: text ${text.toFixed(2)}`);
      }
    }
  }
});

Deno.test("on Nord's yellow 5h segment the chip is a deep shade with amber text, and no chip token leaks", () => {
  const out = bar(
    payload({ rate_limits: { five_hour: { used_percentage: 75 }, seven_day: { used_percentage: 10 } } }),
    { preset: "nord" },
  );
  const nord = JSON.parse(Deno.readTextFileSync(new URL("../presets/presets.json", import.meta.url)))
    .find((p: { id: string }) => p.id === "nord");
  const seg = nord.bar.lines[2][1];
  assertStringIncludes(
    out,
    `\x1b[48;2;${rgb("#473d2a")}m\x1b[38;2;${rgb(seg.bg)}m\u{e0b0}\x1b[38;2;${
      rgb("#fabd2f")
    }m\x1b[1m 75% \x1b[22m` +
      `\x1b[48;2;${rgb(seg.bg)}m\x1b[38;2;${rgb("#473d2a")}m\u{e0b0}\x1b[48;2;${rgb(seg.bg)}m\x1b[38;2;${
        rgb(seg.fg)
      }m`,
  );
  // deno-lint-ignore no-control-regex -- the chip's placeholder bytes
  assert(!/[\x00-\x07]/.test(out), "an unresolved chip token");
});

Deno.test("below 70% a percentage is a calm chip: the segment's color a shade toward its text", () => {
  assertEquals(mix("#000000", "#ffffff", 0.2), "#333333");
  const out = bar(
    payload({ rate_limits: { five_hour: { used_percentage: 42 }, seven_day: { used_percentage: 10 } } }),
    { preset: "fusain" },
  );
  const fusain = JSON.parse(Deno.readTextFileSync(new URL("../presets/presets.json", import.meta.url)))
    .find((p: { id: string }) => p.id === "fusain");
  const seg = fusain.bar.lines[2][1];
  const calm = mix(seg.bg, seg.fg, 0.2);
  assertStringIncludes(
    out,
    `\x1b[48;2;${rgb(calm)}m\x1b[38;2;${rgb(seg.bg)}m\u{e0b0}\x1b[38;2;${rgb(seg.fg)}m 42% ` +
      `\x1b[48;2;${rgb(seg.bg)}m\x1b[38;2;${rgb(calm)}m\u{e0b0}`,
  );
  assert(!out.includes("\x1b[1m 42%"), "calm chips aren't bold");
});

Deno.test("a spent 5-hour window keeps its · before the reset time (no chip there)", () => {
  const out = plain(
    payload({
      rate_limits: {
        five_hour: { used_percentage: 100, resets_at: now() + 3600 },
        seven_day: { used_percentage: 40 },
      },
    }),
  );
  assertStringIncludes(out, "\uf071 Extra · ");
});

Deno.test("session time pads its minutes: 13h03m, not 13h3m", () => {
  const at = (ms: number) =>
    plain(
      payload({
        cost: { total_cost_usd: 1, total_lines_added: 1, total_lines_removed: 0, total_duration_ms: ms },
      }),
    );
  assertStringIncludes(at((13 * 60 + 3) * 60e3), " 13h03m");
  assertStringIncludes(at(2 * 3600e3), " 2h00m");
  assertStringIncludes(at(3 * 60e3), " 3m");
});
