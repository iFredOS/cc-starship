// The keyboard picker: ↑/↓ through presets with a live preview of the status bar
// and shell prompt in this very terminal and font, Enter to install or apply,
// U to uninstall, Q or Esc to quit without changing anything.
import { doInstall, previewLines, runUninstall, VERSION } from "./app.ts";
import { setTheme } from "./engine.ts";
import { readState } from "./paths.ts";
import { allPresets, DEFAULT_PRESET, type Preset } from "./presets.ts";
import { findStarship, latestVersion, type StarshipInfo, updatePlan } from "./starship.ts";

const ESC = "\x1b";
const bold = (s: string) => `${ESC}[1m${s}${ESC}[0m`;
const dim = (s: string) => `${ESC}[2m${s}${ESC}[0m`;
const green = (s: string) => `${ESC}[32m${s}${ESC}[0m`;
const yellow = (s: string) => `${ESC}[33m${s}${ESC}[0m`;
const LIST_HEIGHT = 7;

// What each preview line shows, in the order its segments appear.
const EXPLAIN = {
  bar: [
    ["✻ model · ◐ effort level · \u{f02b} Claude Code version · \u{f007} signed-in account"],
    ["\u{f07b} folder · \u{e725} branch or worktree (↑ ahead ↓ behind * uncommitted) · \u{f440} lines changed · \u{f017} session time"],
    [
      "\u{f1c0} context used (cost) · \u{f06d} prompt cache: minutes left · \u{f252} 5-hour limit · \u{f073} 7-day limit, with resets",
      "a percentage turns into an amber chip at 70%, a red ▲ chip at 90%",
    ],
  ],
  prompt: [
    "user · \u{f07b} folder · \u{e725} git branch · language versions · ✻ Claude usage · \u{f19a0} last command's time",
  ],
};

/** The preview: status bar and shell prompt as separate titled blocks, optionally explained. */
export function previewBlock(lines: string[], opts: { explain: boolean }): string[] {
  const bar = lines.slice(0, -1);
  const prompt = lines[lines.length - 1] ?? "";
  const caption = (
    texts: string[] | undefined,
  ) => (opts.explain ? (texts ?? []).map((t) => dim(`    ${t}`)) : []);
  return [
    bold("Claude Code status bar"),
    ...bar.flatMap((line, i) => [`  ${line}`, ...caption(EXPLAIN.bar[i])]),
    "",
    bold("Shell prompt"),
    `  ${prompt}`,
    ...caption(EXPLAIN.prompt),
  ];
}

const encoder = new TextEncoder();
const write = (s: string) => Deno.stdout.writeSync(encoder.encode(s));

type Key = "up" | "down" | "enter" | "quit" | "uninstall" | "yes" | "explain" | "other";

function parseKey(bytes: Uint8Array): Key {
  const s = new TextDecoder().decode(bytes);
  if (s === `${ESC}[A` || s === "k" || s === "w") return "up";
  if (s === `${ESC}[B` || s === "j" || s === "s") return "down";
  if (s === "\r" || s === "\n") return "enter";
  if (s === ESC || s === "q" || s === "Q" || s === "\x03") return "quit";
  if (s === "u" || s === "U") return "uninstall";
  if (s === "y" || s === "Y") return "yes";
  if (s === "e" || s === "E" || s === "?") return "explain";
  return "other";
}

async function readKey(): Promise<Key> {
  const buf = new Uint8Array(16);
  const n = await Deno.stdin.read(buf);
  return n === null ? "quit" : parseKey(buf.subarray(0, n));
}

function starshipLine(info: StarshipInfo | null, latest: string | null | undefined): string {
  if (latest === undefined) {
    return `Starship ${info?.version ?? "not found"} ${dim("(checking for updates…)")}`;
  }
  if (!info) return yellow(`Starship isn't installed: Enter will download ${latest ?? "it"} for you.`);
  const plan = latest ? updatePlan(info, latest) : null;
  if (!plan) return green(`Starship ${info.version} ✓`) + (latest ? dim(" (latest)") : "");
  const how = plan.kind === "command" ? `with ${plan.command[0]}` : "by downloading it";
  return yellow(`Starship ${info.version}: Enter will update it to ${latest} ${how}.`);
}

function fontHint(): string {
  const icons = "\uf07b \ue725 \uf1c0 \uf06d \uf252 \uf073 \ue0b6\ue0b0\ue0b4";
  const terminalApp = Deno.env.get("TERM_PROGRAM") === "Apple_Terminal";
  const tip = terminalApp
    ? "Terminal.app's default font has none: open this from iTerm, Ghostty or cmux, or pick a Nerd Font in Terminal settings."
    : "Boxes or ? instead of icons mean your terminal font isn't a Nerd Font.";
  return `Icons: ${icons}   ${dim(tip)}`;
}

export async function runUi(): Promise<number> {
  const presets = allPresets();
  let state = readState();
  let index = Math.max(0, presets.findIndex((p) => p.id === (state?.theme ?? DEFAULT_PRESET)));
  let info = findStarship();
  let latest: string | null | undefined = undefined;
  let message = "";
  let explain = true;
  const previews = new Map<string, string[]>();
  const preview = (p: Preset) => {
    if (!previews.has(p.id)) previews.set(p.id, previewLines(p, info?.path ?? "starship"));
    return previews.get(p.id)!;
  };

  const draw = () => {
    const p = presets[index];
    const top = Math.min(
      Math.max(0, index - Math.floor(LIST_HEIGHT / 2)),
      Math.max(0, presets.length - LIST_HEIGHT),
    );
    const list = presets.slice(top, top + LIST_HEIGHT).map((q, i) => {
      const at = top + i;
      const mark = q.id === state?.theme ? green(" ● in use") : "";
      return at === index ? bold(`  ▸ ${q.name}`) + mark : `    ${q.name}${mark}`;
    });
    const lines = [
      bold(`starship-statusline ${VERSION}`) + dim("  ·  Claude Code status bar + shell prompt"),
      "",
      `Choose a look (${index + 1} of ${presets.length}):`,
      top > 0 ? dim("    ↑ more") : "",
      ...list,
      top + LIST_HEIGHT < presets.length ? dim("    ↓ more") : "",
      "",
      dim(`─── Preview: ${p.name} `.padEnd(60, "─")),
      ...(info
        ? previewBlock(preview(p), { explain })
        : [dim("  (the preview appears once Starship is installed)")]),
      "",
      fontHint(),
      starshipLine(info, latest),
      state
        ? dim(`Installed · current look: ${presets.find((q) => q.id === state!.theme)?.name}`)
        : dim("Not installed yet"),
      "",
      message ||
      dim(
        `↑/↓ choose   Enter ${state ? "use this look" : "install with this look"}   E ${
          explain ? "hide" : "show"
        } explanations   ${state ? "U uninstall   " : ""}Q quit`,
      ),
    ];
    write(`${ESC}[H${ESC}[2J${lines.join("\r\n")}`);
  };

  const prompt = async (text: string) => {
    write(`\r\n\r\n${text}`);
    return await readKey();
  };

  write(`${ESC}[?1049h${ESC}[?25l`);
  Deno.stdin.setRaw(true);
  latestVersion().then((v) => (latest = v), () => (latest = null)).then(draw);
  try {
    while (true) {
      draw();
      message = "";
      const key = await readKey();
      if (key === "quit") return 0;
      if (key === "explain") explain = !explain;
      if (key === "up") index = (index - 1 + presets.length) % presets.length;
      if (key === "down") index = (index + 1) % presets.length;
      if (key === "uninstall" && state) {
        if (await prompt(yellow("Uninstall and put back your previous settings? (y/N) ")) !== "yes") continue;
        Deno.stdin.setRaw(false);
        write("\r\n\r\n");
        const code = await runUninstall((l) => console.log(`  ${l}`));
        console.log(
          code === 0
            ? green("\nUninstalled. Your previous prompt and status bar are back in new tabs.")
            : yellow("\nUninstall stopped with an error (see above)."),
        );
        Deno.stdin.setRaw(true);
        await prompt("Press any key to close.");
        return 0;
      }
      if (key === "enter") {
        const p = presets[index];
        if (state) {
          await setTheme(p.id);
          message = green(`✓ ${p.name} is on: open a new terminal tab; Claude Code updates within a minute.`);
        } else {
          Deno.stdin.setRaw(false);
          write("\r\n\r\nInstalling…\r\n");
          try {
            await doInstall(p.id, true, (l) => console.log(`  ${l}`));
            console.log(
              green(`\nInstalled with ${p.name}. Open a new terminal tab, and restart Claude Code.`),
            );
          } catch (e) {
            console.log(yellow(`\nInstall failed: ${e instanceof Error ? e.message : e}`));
          }
          Deno.stdin.setRaw(true);
          await prompt("Press any key to continue.");
          info = findStarship();
          previews.clear();
        }
        state = readState();
      }
    }
  } finally {
    try {
      Deno.stdin.setRaw(false);
    } catch {
      // not a terminal any more
    }
    write(`${ESC}[?25h${ESC}[?1049l`);
  }
}
