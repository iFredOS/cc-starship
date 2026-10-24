import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import {
  assetName,
  compareVersions,
  managedBy,
  parseVersion,
  uninstallPlan,
  updatePlan,
} from "../src/starship.ts";
import { downloadStarship, latestVersion } from "../src/starship.ts";
import { tempDir } from "./helpers.ts";

Deno.test("parses `starship --version`", () => {
  assertEquals(parseVersion("starship 1.27.0\nbranch:\ncommit_hash:"), "1.27.0");
  assertEquals(parseVersion("nonsense"), null);
});

Deno.test("compares versions numerically", () => {
  assert(compareVersions("1.26.0", "1.27.0") < 0);
  assert(compareVersions("1.27.0", "1.9.9") > 0);
  assertEquals(compareVersions("v1.27.0", "1.27.0"), 0);
});

Deno.test("picks the release asset for each platform", () => {
  assertEquals(assetName("darwin", "aarch64"), "starship-aarch64-apple-darwin.tar.gz");
  assertEquals(assetName("darwin", "x86_64"), "starship-x86_64-apple-darwin.tar.gz");
  assertEquals(assetName("windows", "x86_64"), "starship-x86_64-pc-windows-msvc.zip");
  assertEquals(assetName("windows", "aarch64"), "starship-aarch64-pc-windows-msvc.zip");
});

Deno.test("knows who installed starship", () => {
  assertEquals(managedBy("/opt/homebrew/bin/starship"), "brew");
  assertEquals(managedBy("C:\\Program Files\\starship\\bin\\starship.exe"), "winget");
  assertEquals(managedBy("C:\\Users\\me\\scoop\\shims\\starship.exe"), "scoop");
  assertEquals(
    managedBy(
      "/home/me/.local/share/starship-statusline/bin/starship",
      "/home/me/.local/share/starship-statusline",
    ),
    "ours",
  );
  assertEquals(managedBy("/usr/bin/starship"), "unknown");
});

Deno.test("update plan: package manager when it owns starship, else our own download", () => {
  assertEquals(
    updatePlan({ path: "/opt/homebrew/bin/starship", version: "1.26.0", managedBy: "brew" }, "1.27.0"),
    {
      kind: "command",
      command: ["brew", "upgrade", "starship"],
    },
  );
  assertEquals(
    updatePlan({
      path: "C:\\Program Files\\starship\\bin\\starship.exe",
      version: "1.26.0",
      managedBy: "winget",
    }, "1.27.0")
      ?.kind,
    "command",
  );
  assertEquals(updatePlan({ path: "/usr/bin/starship", version: "1.26.0", managedBy: "unknown" }, "1.27.0"), {
    kind: "download",
  });
  assertEquals(
    updatePlan({ path: "/opt/homebrew/bin/starship", version: "1.27.0", managedBy: "brew" }, "1.27.0"),
    null,
  );
  assertEquals(updatePlan(null, "1.27.0"), { kind: "download" });
});

Deno.test({
  name: "downloads and verifies the latest starship (network)",
  ignore: Deno.env.get("NETWORK") !== "1",
  fn: async () => {
    const dir = tempDir();
    const path = await downloadStarship(join(dir, "bin"));
    const out = new Deno.Command(path, { args: ["--version"] }).outputSync();
    assert(parseVersion(new TextDecoder().decode(out.stdout)));
  },
});

Deno.test("uninstall plan: our own copy is deleted, a package manager's goes through it", () => {
  assertEquals(uninstallPlan({ path: "/x/bin/starship", version: "1.27.0", managedBy: "ours" }), {
    kind: "delete",
    path: "/x/bin/starship",
  });
  assertEquals(uninstallPlan({ path: "/opt/homebrew/bin/starship", version: "1.27.0", managedBy: "brew" }), {
    kind: "command",
    command: ["brew", "uninstall", "starship"],
  });
  assertEquals(
    uninstallPlan({
      path: "C:\\Program Files\\starship\\bin\\starship.exe",
      version: "1",
      managedBy: "winget",
    }),
    { kind: "command", command: ["winget", "uninstall", "--id", "Starship.Starship", "--exact", "--silent"] },
  );
  assertEquals(uninstallPlan({ path: "/usr/bin/starship", version: "1", managedBy: "unknown" }), null);
});

Deno.test({
  name: "finds the latest Starship version quickly (network)",
  ignore: Deno.env.get("NETWORK") !== "1",
  fn: async () => {
    const start = Date.now();
    const version = await latestVersion();
    assert(/^\d+\.\d+\.\d+$/.test(version), version);
    assert(Date.now() - start < 5000, `${Date.now() - start} ms`);
  },
});
