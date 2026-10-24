import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { allPresets, barConfig, findPreset, shellConfig } from "../src/presets.ts";
import { tempDir } from "./helpers.ts";

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
  assert(findPreset("rainbow") && findPreset("gray") && findPreset("ember"));
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
    for (const config of [shellConfig(p, "/opt/bin/starship-statusline"), barConfig(p)]) {
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
    findPreset("gray")!,
    "C:\\Users\\me\\AppData\\Local\\starship-statusline\\bin\\x.exe",
  );
  assert(config.includes("shell = ['C:/Users/me/AppData/Local/starship-statusline/bin/x.exe', 'usage']"));
});
