// Compiles the self-contained binaries into dist/. Usage: deno task build [target...]
const TARGETS = ["aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-pc-windows-msvc"];
const targets = Deno.args.length ? Deno.args : TARGETS;

Deno.mkdirSync(new URL("../dist", import.meta.url), { recursive: true });
for (const target of targets) {
  const exe = target.includes("windows") ? ".exe" : "";
  const output = `dist/cc-starship-${target}${exe}`;
  const out = new Deno.Command("deno", {
    args: ["compile", "-A", "--target", target, "--output", output, "src/main.ts"],
    cwd: new URL("..", import.meta.url),
    stdout: "inherit",
    stderr: "inherit",
  }).outputSync();
  if (!out.success) Deno.exit(1);
  console.log(`built ${output}`);
}
