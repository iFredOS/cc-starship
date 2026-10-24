import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { allPresets, barConfig, DEFAULT_PRESET, findPreset, shellConfig } from "../src/presets.ts";
import { stripAnsi, tempDir } from "./helpers.ts";

const starship = (config: string, env: Record<string, string> = {}) => {
  const dir = tempDir();
  const path = join(dir, "starship.toml");
  Deno.writeTextFileSync(path, config);
  const out = new Deno.Command("starship", {
    args: ["prompt"],
    cwd: dir,
    env: { STARSHIP_CONFIG: path, STARSHIP_SHELL: "", ...env },
  }).outputSync();
  return { stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
};

Deno.test("the 15 reviewed presets ship, with unique ids", () => {
  const ids = allPresets().map((p) => p.id);
  assertEquals(ids.length, 15);
  assertEquals(new Set(ids).size, ids.length);
  assert(findPreset("rainbow") && findPreset("fusain") && findPreset("ember"));
});

Deno.test("Fusain, the author's own look, comes first and is the default", () => {
  assertEquals(allPresets()[0].id, "fusain");
  assertEquals(allPresets()[0].name, "Fusain");
  assertEquals(DEFAULT_PRESET, "fusain");
  assertEquals(findPreset("gray")?.id, "fusain", "installs and scripts that said gray keep working");
});

Deno.test("neighbouring segments never share a background", () => {
  for (const p of allPresets()) {
    for (const seq of [...p.bar.lines, p.shell.segments]) {
      for (let i = 1; i < seq.length; i++) assert(seq[i].bg !== seq[i - 1].bg, `${p.id}: ${seq[i].bg}`);
    }
  }
});

Deno.test("every preset gives configs Starship accepts", () => {
  for (const p of allPresets()) {
    for (const config of [shellConfig(p, "/opt/bin/cc-starship"), barConfig(p)]) {
      const { stdout, stderr } = starship(config);
      assert(!/warn|error/i.test(stderr), `${p.id}: ${stderr}`);
      assert(stdout.length > 0, p.id);
    }
  }
});

Deno.test("shell config uses the preset's segment colors", () => {
  const ember = findPreset("ember")!;
  const { stdout } = starship(shellConfig(ember, "/nonexistent/bin"));
  const [r, g, b] = ember.shell.segments[0].bg.match(/\w\w/g)!.map((h) => parseInt(h, 16));
  assert(stdout.includes(`48;2;${r};${g};${b}`), stdout);
});

Deno.test("Windows binary paths get forward slashes in the shell config", () => {
  const config = shellConfig(
    findPreset("fusain")!,
    "C:\\Users\\me\\AppData\\Local\\cc-starship\\bin\\x.exe",
  );
  assert(config.includes("shell = ['C:/Users/me/AppData/Local/cc-starship/bin/x.exe', 'usage']"));
});

Deno.test("clean names: a version only when the same look has another version", () => {
  const names = allPresets().map((p) => p.name);
  for (const p of allPresets()) {
    const m = /^(.*) v(\d+)$/.exec(p.name);
    if (m) {
      assert(names.some((n) => n !== p.name && n.startsWith(`${m[1]} v`)), `${p.name}: no other version`);
    }
    assert(!p.name.includes("-"), `${p.name}: plain words`);
    assert(
      !/-v\d+$/.test(p.id) || allPresets().some((q) => q !== p && q.id.startsWith(p.id.replace(/\d+$/, ""))),
    );
  }
  for (const old of ["sunset-v1", "ocean-v1", "mocha-v1", "nord-v1"]) {
    assertEquals(findPreset(old)?.id, old.replace("-v1", ""), `${old} still works`);
  }
});

Deno.test("previews render asynchronously, both Starship runs at once, same lines as before", async () => {
  const { previewLines, previewLinesAsync } = await import("../src/app.ts");
  const p = findPreset("ember")!;
  const strip = (l: string[]) => l.map((s) => stripAnsi(s).replace(/\d+:\d+ ?[AP]M|\d+ h \d*/g, "T"));
  assertEquals(strip(await previewLinesAsync(p, "starship")), strip(previewLines(p, "starship")));
});
