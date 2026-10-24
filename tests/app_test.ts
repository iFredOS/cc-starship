import { assert, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import { doInstall } from "../src/app.ts";
import { ALL_COMPONENTS, readInstalled } from "../src/engine.ts";
import { tempDir } from "./helpers.ts";

Deno.test({
  name: "install: a font download that fails (no network) doesn't stop the rest",
  ignore: !Deno.env.get("PATH")?.split(":").some((d) => {
    try {
      return Deno.statSync(join(d, "starship")).isFile;
    } catch {
      return false;
    }
  }),
  async fn() {
    const home = tempDir();
    const env: Record<string, string> = {
      HOME: home,
      CC_STARSHIP_HOME: join(home, "install"),
      CC_STARSHIP_PROFILES: join(home, ".zshrc"),
      CC_STARSHIP_TERMINALS: "",
      HTTPS_PROXY: "http://127.0.0.1:9", // nothing listens there: every download fails
    };
    const saved = Object.fromEntries(
      [...Object.keys(env), "CLAUDE_CONFIG_DIR", "STARSHIP_CONFIG"].map((k) => [k, Deno.env.get(k)]),
    );
    for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
    Deno.env.delete("CLAUDE_CONFIG_DIR");
    Deno.env.delete("STARSHIP_CONFIG");
    try {
      const log: string[] = [];
      await doInstall("fusain", false, (l) => log.push(l), { ...ALL_COMPONENTS, terminal: true });
      assert(readInstalled(), "installed");
      assertStringIncludes(log.join("\n"), "font install jetbrains", "says how to get the font later");
    } finally {
      for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
    }
  },
});
