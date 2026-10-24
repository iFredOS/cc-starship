// The control panel, two screens switched with Tab:
// - Looks: ↑/↓ through presets with a live preview of the status bar and shell
//   prompt in this very terminal and font; Enter installs or switches.
// - Components: switch the status bar, shell prompt and usage segment on or off,
//   update or remove Starship, and install a Nerd Font.
// Q or Esc quits without changing anything.
import { doInstall, ensureStarship, previewLines, runUninstall, VERSION } from "./app.ts";
import {
  ALL_COMPONENTS,
  type Components,
  readInstalled,
  setComponents,
  setPrefs,
  setTheme,
} from "./engine.ts";
import {
  detectNerdFonts,
  fontFamilies,
  FONTS,
  installedByUs,
  installFont,
  setWindowsTerminalFont,
  uninstallFont,
  windowsTerminalSettings,
} from "./fonts.ts";
import { HOOK_COST } from "./hook.ts";
import { isWindows, paths } from "./paths.ts";
import { TERMINAL_FONT, TERMINAL_SIZE } from "./terminal.ts";
import { allPresets, DEFAULT_PRESET, type Preset } from "./presets.ts";
import {
  DEFAULT_HOOK_FROM,
  DEFAULT_PREFS,
  formatWhen,
  HOOK_FROM_CHOICES,
  type Prefs,
  resolvePrefs,
} from "./when.ts";
import {
  findStarship,
  latestVersion,
  runUpdate,
  type StarshipInfo,
  uninstallPlan,
  updatePlan,
} from "./starship.ts";

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
    [
      "\u{f07b} folder · \u{e725} branch or worktree (↑ ahead ↓ behind * uncommitted) · \u{f440} lines changed · \u{f017} session time",
    ],
    [
      "\u{f1c0} context used (cost) · \u{f252} 5-hour limit · \u{f073} 7-day limit, with resets",
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
  const caption = (texts: string[] | undefined) =>
    opts.explain ? (texts ?? []).map((t) => dim(`    ${t}`)) : [];
  return [
    bold("Claude Code status bar"),
    ...bar.flatMap((line, i) => [`  ${line}`, ...caption(EXPLAIN.bar[i])]),
    "",
    bold("Shell prompt"),
    `  ${prompt}`,
    ...caption(EXPLAIN.prompt),
  ];
}

export interface PanelInfo {
  installed: boolean;
  components: Components;
  starship: StarshipInfo | null;
  /** Latest Starship release; undefined while checking, null if unknown. */
  latest: string | null | undefined;
  /** Nerd Font families found on this machine. */
  fonts: string[];
  prefs: Prefs;
  /** System locale, for what "Auto" means (tests pass one). */
  locale?: string;
}

const ROWS = [
  "bar",
  "shell",
  "usage",
  "hook",
  "hookFrom",
  "memory",
  "terminal",
  "starship",
  "font",
  "language",
  "clock",
] as const;
type Toggle = "bar" | "shell" | "usage" | "hook" | "memory" | "terminal";
const TOGGLES: readonly string[] = ["bar", "shell", "usage", "hook", "memory", "terminal"];

const LANGUAGES = ["auto", "en", "fr-CA"] as const;
const CLOCKS = ["auto", "24h", "12h"] as const;
const LANGUAGE_NAMES = { en: "English", "fr-CA": "Français (Québec)" };
const CLOCK_NAMES = { "24h": "24 h", "12h": "12 h" };

/** The Components screen's rows, `selected` marked. */
export function componentLines(info: PanelInfo, selected: number): string[] {
  const c = info.components;
  const resolved = resolvePrefs(info.prefs, info.locale);
  const now = new Date();
  const sample = formatWhen(
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 18),
    now,
    resolved,
  );
  const box = (on: boolean) => (on ? green("[x]") : "[ ]");
  const s = info.starship;
  const starshipStatus = !s
    ? yellow("not installed: Enter downloads it")
    : info.latest === undefined
    ? `${s.version ?? "?"} ${dim("(checking for updates…)")}`
    : info.latest && s.version && updatePlan(s, info.latest)
    ? yellow(`${s.version} → ${info.latest} available: Enter updates`)
    : green(`${s.version ?? "?"} ✓`) + dim(info.latest ? " latest" : "");
  const rows = [
    `${box(c.bar)} Claude Code status bar      ${dim("the 3-line bar inside Claude Code")}`,
    `${box(c.shell)} Shell prompt                ${dim("Starship prompt in new terminal tabs")}`,
    `${box(c.usage)} Claude usage in the prompt  ${
      dim(c.shell ? "5h · 7d usage, saved by the status bar" : "needs the shell prompt")
    }`,
    `${box(c.hook)} Usage for Claude            ${
      c.bar
        ? dim("Claude sees context · 5h · 7d; ") + yellow(`costs ${HOOK_COST}`)
        : dim("needs the status bar")
    }`,
    `    Send usage to Claude        ${
      (info.prefs.hookFrom ?? DEFAULT_HOOK_FROM) === 0
        ? "every prompt"
        : `from ${info.prefs.hookFrom ?? DEFAULT_HOOK_FROM}%`
    }   ${dim("silent (0 tokens) until context, 5h or 7d gets there")}`,
    `${box(c.memory)} Shell memory                ${
      dim("new tabs open in your last folder; no duplicate history")
    }`,
    `${box(c.terminal)} Terminal settings           ${
      dim(
        `${TERMINAL_FONT} ${TERMINAL_SIZE}, ${
          isWindows ? "in Windows Terminal" : "Option as Alt, in cmux and Ghostty"
        }`,
      )
    }`,
    `    Starship                    ${starshipStatus}`,
    `    Nerd Font                   ${
      info.fonts.length
        ? green(fontFamilies(info.fonts).slice(0, 3).join(", "))
        : yellow("none found: Enter to pick one")
    }`,
    `    Language                    ${
      info.prefs.language === "auto"
        ? `Auto (${LANGUAGE_NAMES[resolved.language]})`
        : LANGUAGE_NAMES[info.prefs.language]
    }   ${dim(`dates look like: ${sample}`)}`,
    `    Clock                       ${
      info.prefs.clock === "auto" ? `Auto (${CLOCK_NAMES[resolved.clock]})` : CLOCK_NAMES[info.prefs.clock]
    }`,
  ];
  return rows.map((r, i) => (i === selected ? bold(`  ▸ `) + r : `    ${r}`));
}

const encoder = new TextEncoder();
const write = (s: string) => Deno.stdout.writeSync(encoder.encode(s));

type Key =
  | "up"
  | "down"
  | "enter"
  | "quit"
  | "back"
  | "tab"
  | "space"
  | "remove"
  | "uninstall"
  | "yes"
  | "no"
  | "explain"
  | "other";

function parseKey(bytes: Uint8Array): Key {
  const s = new TextDecoder().decode(bytes);
  if (s === `${ESC}[A` || s === "k" || s === "w") return "up";
  if (s === `${ESC}[B` || s === "j" || s === "s") return "down";
  if (s === "\r" || s === "\n") return "enter";
  if (s === ESC) return "back";
  if (s === "q" || s === "Q" || s === "\x03") return "quit";
  if (s === "\t") return "tab";
  if (s === " ") return "space";
  if (s === "x" || s === "X") return "remove";
  if (s === "u" || s === "U") return "uninstall";
  if (s === "y" || s === "Y") return "yes";
  if (s === "n" || s === "N") return "no";
  if (s === "e" || s === "E" || s === "?") return "explain";
  return "other";
}

async function readKey(): Promise<Key> {
  const buf = new Uint8Array(16);
  const n = await Deno.stdin.read(buf);
  return n === null ? "quit" : parseKey(buf.subarray(0, n));
}

function fontHint(): string {
  const icons = "\u{f07b} \u{e725} \u{f1c0} \u{f06d} \u{f252} \u{f073} \u{e0b6}\u{e0b0}\u{e0b4}";
  const terminalApp = Deno.env.get("TERM_PROGRAM") === "Apple_Terminal";
  const tip = terminalApp
    ? "Terminal.app's default font has none: pick a Nerd Font in Terminal settings, or use iTerm, Ghostty or cmux."
    : "Boxes or ? instead of icons mean your terminal font isn't a Nerd Font (see Components).";
  return `Icons: ${icons}   ${dim(tip)}`;
}

type Screen = "looks" | "components" | "fonts";

export async function runUi(): Promise<number> {
  const presets = allPresets();
  let state = readInstalled();
  let components: Components = state?.components ?? { ...ALL_COMPONENTS };
  let prefs: Prefs = state?.prefs ?? DEFAULT_PREFS;
  let index = Math.max(0, presets.findIndex((p) => p.id === (state?.theme ?? DEFAULT_PRESET)));
  let screen: Screen = "looks";
  let row = 0;
  let fontRow = 0;
  let info = findStarship();
  let latest: string | null | undefined = undefined;
  let fonts = detectNerdFonts();
  let message = "";
  let explain = true;
  const previews = new Map<string, string[]>();
  const preview = (p: Preset) => {
    if (!previews.has(p.id)) {
      previews.set(p.id, previewLines(p, info?.path ?? "starship", resolvePrefs(prefs)));
    }
    return previews.get(p.id)!;
  };

  const header = () => {
    const tab = (name: string, on: boolean) => (on ? bold(`[ ${name} ]`) : dim(`  ${name}  `));
    return [
      bold(`starship-statusline ${VERSION}`) + dim("  ·  Claude Code status bar + shell prompt"),
      `${tab("Looks", screen === "looks")} ${tab("Components", screen !== "looks")}   ${dim("Tab switches")}`,
      "",
    ];
  };

  const looks = () => {
    const p = presets[index];
    const top = Math.min(
      Math.max(0, index - Math.floor(LIST_HEIGHT / 2)),
      Math.max(0, presets.length - LIST_HEIGHT),
    );
    const list = presets.slice(top, top + LIST_HEIGHT).map((q, i) => {
      const mark = q.id === state?.theme ? green(" ● in use") : "";
      return top + i === index ? bold(`  ▸ ${q.name}`) + mark : `    ${q.name}${mark}`;
    });
    return [
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
  };

  const componentsScreen = () => [
    state
      ? "Switch parts on or off; changes apply right away."
      : "Choose what to install, then pick a look and press Enter.",
    "",
    ...componentLines({ installed: !!state, components, starship: info, latest, fonts, prefs }, row),
    "",
    fontHint(),
    "",
    message ||
    dim(
      "↑/↓ choose   Space on/off or change   Enter update Starship / pick a font   X remove Starship   Q quit",
    ),
  ];

  const ours = () => installedByUs().map((r) => r.id);
  const fontsScreen = () => [
    "Nerd Fonts give the status bar and prompt their icons.",
    dim(
      isWindows
        ? "Installed for your user; Windows Terminal is switched to it when its settings allow."
        : "Installed for your user; then choose it in your terminal's font settings.",
    ),
    "",
    ...FONTS.map((f, i) => {
      const status = fonts.includes(f.family)
        ? green(ours().includes(f.id) ? "installed by this app" : "installed")
        : dim("not installed");
      const line = `${f.family.padEnd(28)} ${status}`;
      return i === fontRow ? bold("  ▸ ") + line : `    ${line}`;
    }),
    "",
    message || dim("↑/↓ choose   Enter install   X remove (fonts this app installed)   Esc back   Q quit"),
  ];

  const draw = () => {
    const body = screen === "looks" ? looks() : screen === "components" ? componentsScreen() : fontsScreen();
    write(`${ESC}[H${ESC}[2J${[...header(), ...body].join("\r\n")}`);
  };

  const prompt = async (text: string) => {
    write(`\r\n\r\n${text}`);
    return await readKey();
  };

  /** Runs `work` with normal terminal output, then waits for a key. */
  const run = async (title: string, work: (log: (l: string) => void) => Promise<void> | void) => {
    Deno.stdin.setRaw(false);
    write(`\r\n\r\n${title}\r\n`);
    try {
      await work((l) => console.log(`  ${l}`));
    } catch (e) {
      console.log(yellow(`\n${e instanceof Error ? e.message : e}`));
    }
    Deno.stdin.setRaw(true);
    await prompt("Press any key to continue.");
    info = findStarship();
    fonts = detectNerdFonts();
    previews.clear();
    state = readInstalled();
  };

  const toggle = async (key: Toggle) => {
    const next = { ...components, [key]: !components[key] };
    if (key === "usage" && next.usage) next.shell = true;
    if (key === "hook" && next.hook) {
      const ok = await prompt(
        yellow(`Usage for Claude ${HOOK_COST}, sent with each message. Switch it on? (y/N) `),
      );
      if (ok !== "yes") return;
    }
    if (!state) {
      components = next;
      return;
    }
    try {
      await setComponents(next);
      components = next;
      message = green("✓ Saved: open a new terminal tab; Claude Code updates within a minute.");
    } catch (e) {
      message = yellow(e instanceof Error ? e.message : String(e));
    }
  };

  const onComponentsKey = async (key: Key) => {
    if (key === "up") row = (row - 1 + ROWS.length) % ROWS.length;
    if (key === "down") row = (row + 1) % ROWS.length;
    const name = ROWS[row];
    if (key === "space" && TOGGLES.includes(name)) await toggle(name as Toggle);
    if (key === "space" && name === "hookFrom") {
      const i = HOOK_FROM_CHOICES.indexOf((prefs.hookFrom ?? DEFAULT_HOOK_FROM) as 0);
      const next = { ...prefs, hookFrom: HOOK_FROM_CHOICES[(i + 1) % HOOK_FROM_CHOICES.length] };
      if (state) await setPrefs(next);
      prefs = next;
    }
    if (key === "space" && (name === "language" || name === "clock")) {
      const next = name === "language"
        ? { ...prefs, language: LANGUAGES[(LANGUAGES.indexOf(prefs.language) + 1) % LANGUAGES.length] }
        : { ...prefs, clock: CLOCKS[(CLOCKS.indexOf(prefs.clock) + 1) % CLOCKS.length] };
      if (state) await setPrefs(next);
      prefs = next;
      previews.clear();
    }
    if (key === "enter" && name === "font") {
      screen = "fonts";
      fontRow = 0;
    }
    if (key === "enter" && name === "starship") {
      await run("Starship…", async (log) => {
        await ensureStarship(true, log);
      });
    }
    if (key === "remove" && name === "starship" && info) {
      const plan = uninstallPlan(info);
      if (!plan) {
        message = yellow(
          `Starship at ${info.path} wasn't installed by a known package manager; remove it yourself.`,
        );
        return;
      }
      const warn = state
        ? " Your shell prompt and status bar need it, so uninstall them first (U on Looks)."
        : "";
      if (await prompt(yellow(`Remove Starship (${info.path})?${warn} (y/N) `)) !== "yes") return;
      await run("Removing Starship…", (log) => {
        if (plan.kind === "delete") {
          Deno.removeSync(plan.path);
          log(`removed ${plan.path}`);
        } else if (!runUpdate(plan.command)) {
          log(`${plan.command.join(" ")} failed`);
        }
      });
    }
  };

  const onFontsKey = async (key: Key) => {
    if (key === "up") fontRow = (fontRow - 1 + FONTS.length) % FONTS.length;
    if (key === "down") fontRow = (fontRow + 1) % FONTS.length;
    const font = FONTS[fontRow];
    if (key === "enter") {
      await run(`Installing ${font.family}…`, async (log) => {
        (await installFont(font)).forEach(log);
        const wt = isWindows ? windowsTerminalSettings() : null;
        if (wt) {
          const backup = setWindowsTerminalFont(font.family, wt, paths.backups());
          log(
            backup
              ? `Windows Terminal now uses ${font.family} (previous settings saved as ${backup})`
              : `Set it in Windows Terminal: Settings → Defaults → Appearance → Font face → ${font.family}`,
          );
        } else {
          log(`Now choose "${font.family}" as the font in your terminal's settings.`);
        }
      });
    }
    if (key === "remove") {
      if (!ours().includes(font.id)) {
        message = yellow(`${font.family} wasn't installed by this app, so it stays.`);
        return;
      }
      await run(`Removing ${font.family}…`, (log) => uninstallFont(font.id).forEach(log));
    }
  };

  const onLooksKey = async (key: Key) => {
    if (key === "explain") explain = !explain;
    if (key === "up") index = (index - 1 + presets.length) % presets.length;
    if (key === "down") index = (index + 1) % presets.length;
    if (key === "enter") {
      const p = presets[index];
      if (state) {
        await setTheme(p.id);
        state = readInstalled();
        message = green(`✓ ${p.name} is on: open a new terminal tab; Claude Code updates within a minute.`);
      } else {
        if (components.hook) {
          const keep = await prompt(
            yellow(`Usage for Claude ${HOOK_COST}, so Claude knows your limits. Keep it on? (Y/n) `),
          );
          components = { ...components, hook: keep !== "no" };
        }
        await run("Installing…", async (log) => {
          await doInstall(p.id, true, log, components, prefs);
          log(green(`Installed with ${p.name}. Open a new terminal tab, and restart Claude Code.`));
        });
      }
    }
  };

  write(`${ESC}[?1049h${ESC}[?25l`);
  Deno.stdin.setRaw(true);
  latestVersion().then((v) => (latest = v), () => (latest = null)).then(draw);
  try {
    while (true) {
      draw();
      message = "";
      const key = await readKey();
      // Read through a function: the switch to "fonts" happens in callbacks TS can't follow.
      const on = (name: Screen) => screen === name;
      if (key === "quit" || (key === "back" && !on("fonts"))) return 0;
      if (key === "back") {
        screen = "components";
        continue;
      }
      if (key === "tab") {
        screen = screen === "looks" ? "components" : "looks";
        continue;
      }
      if (key === "uninstall" && state && screen === "looks") {
        if (await prompt(yellow("Uninstall and put back your previous settings? (y/N) ")) !== "yes") continue;
        await run("Uninstalling…", async (log) => {
          const code = await runUninstall(log);
          log(
            code === 0 ? green("Uninstalled. Your previous prompt and status bar are back in new tabs.") : "",
          );
        });
        return 0;
      }
      if (screen === "looks") await onLooksKey(key);
      else if (screen === "components") await onComponentsKey(key);
      else await onFontsKey(key);
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
