import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import {
  detectNerdFonts,
  downloadFontFiles,
  fontFamilies,
  FONTS,
  parseChecksum,
  pickFontFiles,
  setWindowsTerminalFont,
} from "../src/fonts.ts";
import { tempDir } from "./helpers.ts";

Deno.test("detects installed Nerd Font families from file names", () => {
  const dir = tempDir();
  for (
    const f of [
      "JetBrainsMonoNerdFont-Regular.ttf",
      "JetBrainsMonoNerdFont-Bold.ttf",
      "JetBrainsMonoNerdFontMono-Regular.ttf",
      "CaskaydiaCoveNerdFont-Regular.ttf",
      "Arial.ttf",
    ]
  ) Deno.writeTextFileSync(join(dir, f), "");
  assertEquals(detectNerdFonts([dir, join(dir, "missing")]), [
    "CaskaydiaCove Nerd Font",
    "JetBrainsMono Nerd Font",
    "JetBrainsMono Nerd Font Mono",
  ]);
});

Deno.test("installs the four standard styles that exist, not Mono/Propo variants", () => {
  const jetbrains = FONTS.find((f) => f.id === "jetbrains")!;
  const names = [
    "JetBrainsMonoNerdFont-Regular.ttf",
    "JetBrainsMonoNerdFont-Bold.ttf",
    "JetBrainsMonoNerdFont-Italic.ttf",
    "JetBrainsMonoNerdFont-BoldItalic.ttf",
    "JetBrainsMonoNerdFont-Light.ttf",
    "JetBrainsMonoNerdFontMono-Regular.ttf",
    "JetBrainsMonoNerdFontPropo-Regular.ttf",
  ];
  assertEquals(pickFontFiles(jetbrains, names), names.slice(0, 4));
  const fira = FONTS.find((f) => f.id === "firacode")!;
  assertEquals(pickFontFiles(fira, ["FiraCodeNerdFont-Regular.ttf", "FiraCodeNerdFont-Bold.ttf"]).length, 2);
});

Deno.test("reads a file's hash from the release checksum list", () => {
  const text = "aaa  Hack.tar.xz\nfa24  Hack.zip\nfab7  JetBrainsMono.zip\n";
  assertEquals(parseChecksum(text, "Hack.zip"), "fa24");
  assertEquals(parseChecksum(text, "Nope.zip"), null);
});

Deno.test("Windows Terminal: sets the default font when settings are plain JSON, else leaves them", () => {
  const dir = tempDir();
  const path = join(dir, "settings.json");
  Deno.writeTextFileSync(path, JSON.stringify({ profiles: { defaults: {}, list: [] } }, null, 4));
  const backup = setWindowsTerminalFont("Hack Nerd Font", path, join(dir, "backups"));
  assert(backup, "changed");
  assertEquals(JSON.parse(Deno.readTextFileSync(path)).profiles.defaults.font.face, "Hack Nerd Font");
  assertEquals(JSON.parse(Deno.readTextFileSync(backup!)).profiles.defaults, {});

  const jsonc = '{\n    // comment\n    "profiles": {}\n}\n';
  Deno.writeTextFileSync(path, jsonc);
  assertEquals(setWindowsTerminalFont("Hack Nerd Font", path, join(dir, "backups")), null);
  assertEquals(Deno.readTextFileSync(path), jsonc);
});

Deno.test({
  name: "downloads, verifies and unpacks a Nerd Font (network)",
  ignore: Deno.env.get("NETWORK") !== "1",
  fn: async () => {
    const files = await downloadFontFiles(FONTS.find((f) => f.id === "hack")!, tempDir());
    assert(files.length >= 2 && files.every((f) => f.endsWith(".ttf")), files.join(", "));
  },
});

Deno.test("detects Microsoft's own Nerd Font builds (…NF.ttf) too", () => {
  const dir = tempDir();
  for (
    const f of ["CascadiaCodeNF.ttf", "CascadiaCodeNFItalic.ttf", "CascadiaMonoNF-Bold.ttf", "Inferno.ttf"]
  ) {
    Deno.writeTextFileSync(join(dir, f), "");
  }
  assertEquals(detectNerdFonts([dir]), ["CascadiaCode NF", "CascadiaMono NF"]);
});

Deno.test("fontFamilies folds Mono/Propo/NL/DZ variants into one entry each", () => {
  assertEquals(
    fontFamilies([
      "JetBrainsMono Nerd Font",
      "JetBrainsMono Nerd Font Mono",
      "JetBrainsMonoNL Nerd Font Propo",
      "MesloLGS Nerd Font",
      "MesloLGSDZ Nerd Font Mono",
      "MesloLGM Nerd Font",
      "CascadiaCode NF",
    ]),
    ["CascadiaCode NF", "JetBrainsMono Nerd Font", "MesloLGM Nerd Font", "MesloLGS Nerd Font"],
  );
});
