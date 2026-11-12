// Compiles the self-contained binaries into dist/. Usage: deno task build [target...]
const TARGETS = ["aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-pc-windows-msvc"];
const targets = Deno.args.length ? Deno.args : TARGETS;

Deno.mkdirSync(new URL("../dist", import.meta.url), { recursive: true });

// Which build this is (see src/version.ts): computed here, never committed.
const git = (...args: string[]) => {
  const out = new Deno.Command("git", {
    args,
    cwd: new URL("..", import.meta.url),
    stdout: "piped",
    stderr: "null",
  })
    .outputSync();
  return out.success ? new TextDecoder().decode(out.stdout).trim() : null;
};
const count = git("rev-list", "--count", "HEAD");
const short = git("rev-parse", "--short=7", "HEAD");
const dirty = (git("status", "--porcelain") ?? "") !== "";
const date = git("log", "-1", "--pretty=%ct");
// Without git (a `git archive` copy): CC_STARSHIP_BUILD / _COMMIT / _DATE, or unknown.
const info = {
  build: count ? Number(count) : Number(Deno.env.get("CC_STARSHIP_BUILD")) || null,
  commit: short ? `${short}${dirty ? "-modified" : ""}` : Deno.env.get("CC_STARSHIP_COMMIT") ?? null,
  date: date ? Number(date) : Number(Deno.env.get("CC_STARSHIP_DATE")) || null,
};
Deno.writeTextFileSync(new URL("../dist/build.json", import.meta.url), JSON.stringify(info) + "\n");
console.log(`build ${info.build ?? "unknown"} · ${info.commit ?? "unknown"}`);
for (const target of targets) {
  const exe = target.includes("windows") ? ".exe" : "";
  const output = `dist/cc-starship-${target}${exe}`;
  const out = new Deno.Command("deno", {
    args: [
      "compile",
      "-A",
      "--include",
      "dist/build.json",
      "--target",
      target,
      "--output",
      output,
      "src/main.ts",
    ],
    cwd: new URL("..", import.meta.url),
    stdout: "inherit",
    stderr: "inherit",
  }).outputSync();
  if (!out.success) Deno.exit(1);
  console.log(`built ${output}`);
}
