import { assertEquals } from "@std/assert";
import { buildInfo, VERSION, versionLine } from "../src/version.ts";

const host = { os: "macOS", osVersion: "27.3", arch: "arm64" };

Deno.test("version line: version, build number and commit, kind, system", () => {
  assertEquals(
    versionLine({ version: "1.3.0", build: 176, commit: "fae1f44", date: 1762900000 }, "release", host),
    "cc-starship 1.3.0 (176 · fae1f44) release · macOS 27.3 arm64",
  );
});

Deno.test("version line: no build information says unknown, never a made-up number", () => {
  assertEquals(
    versionLine({ version: "1.3.0", build: null, commit: null, date: null }, "dev", host),
    "cc-starship 1.3.0 (unknown · unknown) dev · macOS 27.3 arm64",
  );
});

Deno.test("build info: read from the file the build writes; missing or broken means unknown", () => {
  assertEquals(buildInfo('{"build":176,"commit":"fae1f44","date":1762900000}'), {
    version: VERSION,
    build: 176,
    commit: "fae1f44",
    date: 1762900000,
  });
  const unknown = { version: VERSION, build: null, commit: null, date: null };
  assertEquals(buildInfo(null), unknown);
  assertEquals(buildInfo("not json"), unknown);
  assertEquals(buildInfo('{"build":"12","commit":5}'), unknown, "wrong types");
});

Deno.test("a release tag on this commit matches VERSION", () => {
  const out = new Deno.Command("git", {
    args: ["describe", "--exact-match", "--tags", "--match", "v*", "HEAD"],
    cwd: new URL("..", import.meta.url),
    stdout: "piped",
    stderr: "null",
  }).outputSync();
  if (!out.success) return; // no tag here (or no git): nothing to compare
  assertEquals(new TextDecoder().decode(out.stdout).trim(), `v${VERSION}`);
});
