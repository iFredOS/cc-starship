// The control panel, two screens switched with Tab:
// - Looks: ↑/↓ through presets with a live preview of the status bar and shell
//   prompt in this very terminal and font; Enter installs or switches.
// - Components: switch the status bar, shell prompt and usage segment on or off,
//   update or remove Starship, and install a Nerd Font.
// Q or Esc quits without changing anything.
import { doInstall, ensureStarship, previewLinesAsync, runUninstall, VERSION } from "./app.ts";
import {
  ALL_COMPONENTS,
  type Components,
  readInstalled,
  refreshProfilePaths,
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
import { allPresets, DEFAULT_PRESET, findPreset, type Preset } from "./presets.ts";
import { gitStatus } from "./statusline.ts";
import {
  box,
  clip,
  fitView,
  gridShape,
  header,
  keys,
  looksGrid,
  paint,
  type Theme,
  themeOf,
} from "./panel.ts";
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
/** Switch icons on the Components screen. */
export const ON = "\u{f205}", OFF = "\u{f204}";
const defaultTheme = () => themeOf(findPreset(DEFAULT_PRESET)!);

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
export function previewBlock(lines: string[], opts: { explain: boolean; theme?: Theme }): string[] {
  const heading = (s: string) => (opts.theme ? `${ESC}[1m${paint(opts.theme.second, s)}` : bold(s));
  const bar = lines.slice(0, -1);
  const prompt = lines[lines.length - 1] ?? "";
  const caption = (texts: string[] | undefined) =>
    opts.explain ? (texts ?? []).map((t) => dim(`    ${t}`)) : [];
  return [
    heading("Claude Code status bar"),
    ...bar.flatMap((line, i) => [`  ${line}`, ...caption(EXPLAIN.bar[i])]),
    "",
    heading("Shell prompt"),
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
export function componentLines(info: PanelInfo, selected: number, theme = defaultTheme()): string[] {
  const c = info.components;
  const resolved = resolvePrefs(info.prefs, info.locale);
  const now = new Date();
  const sample = formatWhen(
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 18),
    now,
    resolved,
  );
  const box = (on: boolean) => (on ? paint(theme.accent, ON) : paint(theme.dim, OFF));
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
      c.bar ? dim("Claude sees your usage; ") + yellow(`costs ${HOOK_COST}`) : dim("needs the status bar")
    }`,
    `  Send usage to Claude        ${
      (info.prefs.hookFrom ?? DEFAULT_HOOK_FROM) === 0
        ? "every prompt"
        : `from ${info.prefs.hookFrom ?? DEFAULT_HOOK_FROM}%`
    }   ${dim("silent (0 tokens) until context, 5h or 7d gets there")}`,
    `${box(c.memory)} Shell memory                ${
      dim(
        "new tabs open in your last folder; no duplicate history",
      )
    }`,
    `${box(c.terminal)} Terminal settings           ${
      dim(
        `${TERMINAL_FONT} ${TERMINAL_SIZE}, ${
          isWindows ? "in Windows Terminal" : "Option as Alt, in cmux and Ghostty"
        }`,
      )
    }`,
    `  Starship                    ${starshipStatus}`,
    `  Nerd Font                   ${
      info.fonts.length
        ? green(fontFamilies(info.fonts).slice(0, 3).join(", "))
        : yellow("none found: Enter to pick one")
    }`,
    `  Language                    ${
      info.prefs.language === "auto"
        ? `Auto (${LANGUAGE_NAMES[resolved.language]})`
        : LANGUAGE_NAMES[info.prefs.language]
    }   ${dim(`dates look like: ${sample}`)}`,
    `  Clock                       ${
      info.prefs.clock === "auto" ? `Auto (${CLOCK_NAMES[resolved.clock]})` : CLOCK_NAMES[info.prefs.clock]
    }`,
  ];
  return rows.map((r, i) => (i === selected ? `${ESC}[1m${paint(theme.accent, "▸")} ${r}` : `  ${r}`));
}

const encoder = new TextEncoder();
const write = (s: string) => Deno.stdout.writeSync(encoder.encode(s));

type Key =
  | "up"
  | "down"
  | "left"
  | "right"
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

function parseKey(s: string): Key {
  if (s === `${ESC}[A` || s === `${ESC}OA` || s === "k" || s === "w") return "up";
  if (s === `${ESC}[B` || s === `${ESC}OB` || s === "j" || s === "s") return "down";
  if (s === `${ESC}[D` || s === `${ESC}OD` || s === "h") return "left";
  if (s === `${ESC}[C` || s === `${ESC}OC` || s === "l") return "right";
  if (s === "\r" || s === "\n" || s === "\r\n") return "enter";
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

/** Every key in one read: a held arrow key or fast typing arrives several at a time. */
export function parseKeys(bytes: Uint8Array): Key[] {
  // Esc followed by another character is Alt/Option+that key, one key; Esc Esc is two.
  // deno-lint-ignore no-control-regex -- escape sequences
  const KEY = /\x1b\[[0-9;]*[A-Za-z~]|\x1bO.|\x1b[^[O\x1b]|\r\n|[\s\S]/g;
  const tokens = new TextDecoder().decode(bytes).match(KEY) ?? [];
  return tokens.map(parseKey);
}

async function readKeys(): Promise<Key[]> {
  const buf = new Uint8Array(256);
  const n = await Deno.stdin.read(buf);
  return n === null ? ["quit"] : parseKeys(buf.subarray(0, n));
}

/** One answer: the first key of the next read (keys typed before the question don't answer it). */
const readKey = async (): Promise<Key> => (await readKeys())[0] ?? "other";

function fontHint(theme: Theme): string {
  const icons = "\u{f07b} \u{e725} \u{f1c0} \u{f06d} \u{f252} \u{f073} \u{e0b6}\u{e0b0}\u{e0b4}";
  const terminalApp = Deno.env.get("TERM_PROGRAM") === "Apple_Terminal";
  const tip = terminalApp
    ? "Terminal.app's default font has none: pick a Nerd Font in Terminal settings, or use iTerm, Ghostty or cmux."
    : "Boxes or ? instead of icons: your terminal font isn't a Nerd Font (see Components).";
  return ` ${paint(theme.dim, "Icons")} ${paint(theme.text, icons)}   ${paint(theme.dim, tip)}`;
}

type Screen = "looks" | "components" | "fonts";

export async function runUi(): Promise<number> {
  const presets = allPresets();
  let state = readInstalled();
  let components: Components = state?.components ?? { ...ALL_COMPONENTS };
  let prefs: Prefs = state?.prefs ?? DEFAULT_PREFS;
  let index = Math.max(0, presets.findIndex((p) => p.id === findPreset(state?.theme ?? DEFAULT_PRESET)?.id));
  let screen: Screen = "looks";
  let row = 0;
  let fontRow = 0;
  let info = findStarship();
  let latest: string | null | undefined = undefined;
  let fonts = detectNerdFonts();
  let message = "";
  let explain = true;
  // Previews render in the background, so arrow keys never wait: both Starship runs of a
  // preview at once, one git status for all looks, always the look nearest the cursor next.
  const git = gitStatus(Deno.cwd());
  // One folder for every preview's files, removed when the panel closes.
  const previewRoot = Deno.makeTempDirSync({ prefix: "cc-starship-panel-" });
  const previews = new Map<string, string[]>();
  let generation = 0;
  let idle = false; // waiting for a key: safe to redraw when a preview arrives
  const warm = async () => {
    const gen = ++generation;
    previews.clear();
    while (gen === generation) {
      const next = presets
        .map((p, i) => ({ p, distance: Math.abs(i - index) }))
        .sort((a, b) => a.distance - b.distance)
        .find(({ p }) => !previews.has(p.id))?.p;
      if (!next) return;
      const lines = await previewLinesAsync(next, info?.path ?? "starship", {
        prefs: resolvePrefs(prefs),
        git,
        root: previewRoot,
      }).catch(() => [] as string[]);
      if (gen !== generation) return;
      previews.set(next.id, lines);
      if (screen === "looks" && presets[index].id === next.id) redraw();
    }
  };
  const preview = (p: Preset) => previews.get(p.id);

  const width = () => {
    try {
      return Math.min(Deno.consoleSize().columns - 2, 116);
    } catch {
      return 100;
    }
  };
  // The panel takes the colors of the look under the cursor.
  const theme = () => themeOf(presets[index]);
  const inUse = () => (state ? findPreset(state.theme)?.id : undefined);
  // Same height as a finished preview, so the screen doesn't jump when it arrives.
  const rendering = (explain: boolean, t: Theme) => {
    const ready = [...previews.values()].find((l) => l.length);
    const rows = ready ? previewBlock(ready, { explain }).length : 1;
    return [paint(t.dim, "rendering the preview…"), ...Array(Math.max(0, rows - 1)).fill("")];
  };
  const columns = () => {
    try {
      return Deno.consoleSize().columns;
    } catch {
      return 100;
    }
  };
  const height = () => {
    try {
      return Deno.consoleSize().rows;
    } catch {
      return 40;
    }
  };
  const footer = (pairs: [string, string][], roomy = true) => [
    ...(roomy ? [""] : []),
    message ? ` ${message}` : "",
    ...keys(pairs, theme(), columns() - 1),
  ];

  /** `eKey`: the window has room for the explanations, so E does something. */
  const looks = ({ explain, roomy, eKey }: { explain: boolean; roomy: boolean; eKey: boolean }) => {
    const t = theme(), p = presets[index], w = width();
    const mark = inUse() ? ` · ${paint(t.second, "●")}${paint(t.dim, " in use")}` : "";
    const legend = `${paint("#fabd2f", "amber")}${paint(t.dim, " at 70% · ")}${paint("#fb4934", "red ▲")}${
      paint(t.dim, " at 90%")
    }`;
    return [
      ...box("Choose a look", looksGrid(presets, { index, inUse: inUse(), width: w - 4, theme: t }), {
        width: w,
        theme: t,
        right: paint(t.dim, `${index + 1} of ${presets.length}`) + mark,
      }),
      ...(roomy ? [""] : []),
      ...box(
        `Preview · ${p.name}`,
        !info
          ? [paint(t.dim, "(the preview appears once Starship is installed)")]
          : preview(p)
          ? previewBlock(preview(p)!, { explain, theme: t })
          : rendering(explain, t),
        { width: w, theme: t, right: legend },
      ),
      ...(roomy ? ["", fontHint(t)] : []),
      state ? "" : ` ${paint(t.dim, "Not installed yet: Enter installs with the look under the cursor.")}`,
      ...footer([
        ["↑↓←→", "choose"],
        ["⏎", state ? "use this look" : "install with this look"],
        ...(eKey ? [["E", explain ? "hide explanations" : "explanations"] as [string, string]] : []),
        ...(state ? [["U", "uninstall"] as [string, string]] : []),
        ["Tab", "components"],
        ["Q", "quit"],
      ], roomy),
    ];
  };

  const componentsScreen = ({ roomy }: { roomy: boolean }) => {
    const t = theme();
    const intro = state
      ? "Switch parts on or off; changes apply right away."
      : "Choose what to install, then pick a look and press Enter.";
    return [
      ...box("Components", [
        paint(t.dim, intro),
        "",
        ...componentLines({ installed: !!state, components, starship: info, latest, fonts, prefs }, row, t),
      ], { width: width(), theme: t }),
      ...(roomy ? ["", fontHint(t)] : []),
      ...footer([
        ["↑↓", "choose"],
        ["Space", "change"],
        ["⏎", "update Starship · fonts"],
        ["X", "remove Starship"],
        ["Tab", "looks"],
        ["Q", "quit"],
      ], roomy),
    ];
  };

  const ours = () => installedByUs().map((r) => r.id);
  const fontsScreen = () => {
    const t = theme();
    return [
      ...box("Nerd Fonts", [
        paint(t.text, "Nerd Fonts give the status bar and prompt their icons."),
        paint(
          t.dim,
          isWindows
            ? "Installed for your user; Windows Terminal is switched to it when its settings allow."
            : "Installed for your user; then choose it in your terminal's font settings.",
        ),
        "",
        ...FONTS.map((f, i) => {
          const status = fonts.includes(f.family)
            ? green(ours().includes(f.id) ? "installed by this app" : "installed")
            : paint(t.dim, "not installed");
          const line = `${f.family.padEnd(28)} ${status}`;
          return i === fontRow ? `${ESC}[1m${paint(t.accent, "▸")} ${line}` : `  ${line}`;
        }),
      ], { width: width(), theme: t }),
      ...footer([["↑↓", "choose"], ["⏎", "install"], ["X", "remove (fonts this app installed)"], [
        "Esc",
        "back",
      ], [
        "Q",
        "quit",
      ]]),
    ];
  };

  const draw = () => {
    // Taller than the window, the terminal would scroll the top away: explanations go first,
    // then the spacing.
    const top = (roomy: boolean) =>
      header({ theme: theme(), screen, version: VERSION, width: width(), roomy });
    const eKey = screen === "looks" &&
      [...top(true), ...looks({ explain: true, roomy: true, eKey: true })].length <= height();
    const layouts = screen === "looks"
      ? [
        () => [...top(true), ...looks({ explain, roomy: true, eKey })],
        () => [...top(true), ...looks({ explain: false, roomy: true, eKey })],
        () => [...top(false), ...looks({ explain: false, roomy: false, eKey })],
      ]
      : screen === "components"
      ? [
        () => [...top(true), ...componentsScreen({ roomy: true })],
        () => [...top(false), ...componentsScreen({ roomy: false })],
      ]
      : [() => [...top(true), ...fontsScreen()]];
    // Cut to the window (one column spare): a line that wraps would push the top away.
    const lines = fitView(layouts, height()).map((l) => clip(l, columns() - 1));
    write(`${ESC}[H${ESC}[2J${lines.join("\r\n")}`);
  };
  /** A redraw from a background task: only while waiting for a key, and never fatal. */
  const redraw = () => {
    if (!idle) return;
    try {
      draw();
    } catch {
      // the panel is closing
    }
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
    warm();
    state = readInstalled();
  };

  /** Runs a change; when it fails (settings.json with comments…), says why and returns false. */
  const saved = async (change: () => Promise<unknown>) => {
    try {
      await change();
      return true;
    } catch (e) {
      message = yellow(e instanceof Error ? e.message : String(e));
      return false;
    }
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
    if (await saved(() => setComponents(next))) {
      components = next;
      message = green("✓ Saved: open a new terminal tab; Claude Code updates within a minute.");
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
      if (state && !(await saved(() => setPrefs(next)))) return;
      prefs = next;
    }
    if (key === "space" && (name === "language" || name === "clock")) {
      const next = name === "language"
        ? { ...prefs, language: LANGUAGES[(LANGUAGES.indexOf(prefs.language) + 1) % LANGUAGES.length] }
        : { ...prefs, clock: CLOCKS[(CLOCKS.indexOf(prefs.clock) + 1) % CLOCKS.length] };
      if (state && !(await saved(() => setPrefs(next)))) return;
      prefs = next;
      warm();
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
    if (key === "left" || key === "right") {
      // The grid fills column by column: a column to the side is a whole column of looks away.
      const { columns, rows } = gridShape(presets.length, width() - 4);
      const column = (Math.floor(index / rows) + (key === "right" ? 1 : columns - 1)) % columns;
      index = Math.min(presets.length - 1, column * rows + (index % rows));
    }
    if (key === "enter") {
      const p = presets[index];
      if (state) {
        if (!(await saved(() => setTheme(p.id)))) return;
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
  latestVersion().then((v) => (latest = v), () => (latest = null)).then(redraw);
  warm();
  if (state) refreshProfilePaths().catch(() => {});
  /** Handles one key; true when the panel should close. */
  const handle = async (key: Key): Promise<boolean> => {
    // Read through a function: the switch to "fonts" happens in callbacks TS can't follow.
    const on = (name: Screen) => screen === name;
    if (key === "quit" || (key === "back" && !on("fonts"))) return true;
    if (key === "back") {
      screen = "components";
      return false;
    }
    if (key === "tab") {
      screen = screen === "looks" ? "components" : "looks";
      return false;
    }
    if (key === "uninstall" && state && screen === "looks") {
      if (await prompt(yellow("Uninstall and put back your previous settings? (y/N) ")) !== "yes") {
        return false;
      }
      await run("Uninstalling…", async (log) => {
        const code = await runUninstall(log);
        log(
          code === 0 ? green("Uninstalled. Your previous prompt and status bar are back in new tabs.") : "",
        );
      });
      return true;
    }
    if (screen === "looks") await onLooksKey(key);
    else if (screen === "components") await onComponentsKey(key);
    else await onFontsKey(key);
    return false;
  };

  try {
    while (true) {
      draw();
      idle = true;
      const keys = await readKeys();
      idle = false;
      message = ""; // shown until the next key
      for (const key of keys) if (await handle(key)) return 0;
    }
  } finally {
    try {
      Deno.stdin.setRaw(false);
    } catch {
      // not a terminal any more
    }
    write(`${ESC}[?25h${ESC}[?1049l`);
    try {
      Deno.removeSync(previewRoot, { recursive: true });
    } catch {
      // a preview still finishing; the system cleans its temp folder
    }
  }
}
