import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import { formatWhen } from "../src/when.ts";
import { bar, barWith, fixture, now, payload, plain, stripAnsi, tempDir } from "./helpers.ts";

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
      "\uf07b ~/projects/my-app",
      "\uf440 +156/−23 · \uf017 2h 21m",
      "\uf1c0 CTX 8% / 15.5K ($1.23)",
      "\uf252 5h 42%",
      "\uf073 7d 13%",
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
  assertStringIncludes(out, "CTX 0% / 0 ($0.00)");
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
    assertStringIncludes(out, `5h 1% · ${when(soon)}`);
    assertStringIncludes(out, `7d 23% · ${when(later)}`);
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
    { preset: "gray" },
  );
  const chip = (bg: string, text: string) =>
    `\x1b[48;2;${rgb(bg)}m\x1b[38;2;${rgb("#1d2021")}m\x1b[1m ${text} \x1b[22m`;
  assertStringIncludes(out, chip("#fb4934", "▲95%"));
  assertStringIncludes(out, chip("#fabd2f", "75%"));
  assert(!out.includes(`${rgb("#fabd2f")}m\x1b[38;2;${rgb("#1d2021")}m\x1b[1m 10%`));
  // After the red chip, the context segment's own background and text color come back.
  const gray = JSON.parse(Deno.readTextFileSync(new URL("../presets/presets.json", import.meta.url)))
    .find((p: { id: string }) => p.id === "gray");
  const seg = gray.bar.lines[2][0];
  assertStringIncludes(out, `▲95% \x1b[22m\x1b[48;2;${rgb(seg.bg)}m\x1b[38;2;${rgb(seg.fg)}m`);
  assertStringIncludes(stripAnsi(out), "CTX  ▲95%  /");
});

Deno.test("accent icons fall back to the segment text when they'd be hard to see", () => {
  const gray = JSON.parse(Deno.readTextFileSync(new URL("../presets/presets.json", import.meta.url)))
    .find((p: { id: string }) => p.id === "gray");
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
  const git = (...args: string[]) => new Deno.Command("git", { args: ["-C", repo, ...args] }).outputSync();
  git("-c", "init.defaultBranch=main", "init", "-q");
  Deno.writeTextFileSync(join(repo, "f"), "hi");
  git("add", "f");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  Deno.writeTextFileSync(join(repo, "f"), "bye");
  assertStringIncludes(plain(payload({}, repo)), "\ue725 main *");
});

Deno.test("prompt cache: minutes while warm, amber from 5, cold once expired", () => {
  const cache = (c: Record<string, unknown>) => payload({ prompt_cache: { caching_observed: true, ...c } });
  assertStringIncludes(plain(cache({ warm: true, expires_at: now() + 42 * 60 + 10 })), "\uf06d 42m");
  assertStringIncludes(
    bar(cache({ warm: true, expires_at: now() + 4 * 60 + 10 })),
    "\x1b[38;2;250;189;47m4m",
  );
  assertStringIncludes(bar(cache({ warm: false, expires_at: null })), "\uf2dc \x1b[38;2;250;189;47mcold");
  assert(!plain(payload()).includes("\uf2dc"));
  assert(!plain(payload({ prompt_cache: { caching_observed: false, warm: false } })).includes("\uf2dc"));
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
    assertStringIncludes(out, "CTX 8%");
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
