import { assertEquals } from "@std/assert";
import { join } from "node:path";
import { previewUsageFile } from "../src/app.ts";
import { home } from "../src/paths.ts";

Deno.test("panel preview saves its sample usage where the preview prompt reads it, per account", () => {
  const before = Deno.env.get("CLAUDE_CONFIG_DIR");
  try {
    Deno.env.set("CLAUDE_CONFIG_DIR", join(home(), ".claude-work"));
    assertEquals(previewUsageFile("/tmp/p"), join("/tmp/p", "usage-work"));
    Deno.env.delete("CLAUDE_CONFIG_DIR");
    assertEquals(previewUsageFile("/tmp/p"), join("/tmp/p", "usage"));
  } finally {
    if (before === undefined) Deno.env.delete("CLAUDE_CONFIG_DIR");
    else Deno.env.set("CLAUDE_CONFIG_DIR", before);
  }
});
