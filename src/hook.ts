// Lets Claude see the status bar's numbers: the bar saves a snapshot per session,
// and a UserPromptSubmit hook hands it to Claude as context with every prompt.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Clock, formatWhen, type Language } from "./when.ts";

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

interface Window {
  pct: number;
  resetsAt: number;
}

interface Snapshot {
  savedAt: number;
  context?: { pct: number; tokens: number };
  costUsd?: number;
  fiveHour?: Window;
  sevenDay?: Window;
}

/**
 * What the hook costs: its line (~150 characters, ~45 tokens) plus Claude Code's wrapper, added to
 * the context of every prompt. Shown before the hook is switched on.
 */
export const HOOK_COST = "about 70 tokens per prompt it speaks up on";

/** The snapshot file for a session; anything but letters, digits, `-` and `_` is dropped. */
export function snapshotFile(dir: string, sessionId: string): string {
  return join(dir, `${String(sessionId).replace(/[^\w-]/g, "") || "unknown"}.json`);
}

const window = (w?: Json): Window | undefined =>
  w?.used_percentage == null ? undefined : { pct: w.used_percentage, resetsAt: w.resets_at ?? 0 };

/** Saves what the status bar shows for this session (run by the bar on every refresh). */
export function saveSnapshot(file: string, j: Json, now = new Date()): void {
  const ctx = j.context_window;
  const snapshot: Snapshot = {
    savedAt: now.getTime() / 1000,
    context: ctx?.used_percentage == null
      ? undefined
      : { pct: ctx.used_percentage, tokens: ctx.total_input_tokens ?? 0 },
    costUsd: j.cost?.total_cost_usd,
    fiveHour: window(j.rate_limits?.five_hour),
    sevenDay: window(j.rate_limits?.seven_day),
  };
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${Deno.pid}`;
    writeFileSync(tmp, JSON.stringify(snapshot));
    renameSync(tmp, file);
  } catch {
    // Claude just gets the previous numbers.
  }
}

function readJson(file: string): Snapshot | null {
  try {
    return JSON.parse(Deno.readTextFileSync(file));
  } catch {
    return null;
  }
}

/** The shared 5h/7d numbers the bar saves for the shell prompt. */
function readUsage(file: string): Snapshot | null {
  try {
    const f = Deno.readTextFileSync(file).trim().split(/\s+/).map(Number);
    if (f.length !== 4 || f.some(Number.isNaN)) return null;
    return { savedAt: 0, fiveHour: { resetsAt: f[0], pct: f[1] }, sevenDay: { resetsAt: f[2], pct: f[3] } };
  } catch {
    return null;
  }
}

export interface HookOptions {
  sessions: string;
  usageFile: string;
  prefs: { language: Language; clock: Clock };
  now?: Date;
  /** Send nothing until context, 5h or 7d reaches this percentage; 0 = every prompt. */
  from?: number;
}

/** "45m", "2h 10m", "2d 6h". */
function timeLeft(seconds: number): string {
  const m = Math.max(1, Math.round(seconds / 60));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return h % 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${Math.floor(h / 24)}d`;
}

/** The highest of context, 5h and 7d now (a window past its reset counts as 0). */
function highest(s: Snapshot, now: Date): number {
  const current = (w?: Window) => (!w ? 0 : w.resetsAt > 0 && now.getTime() / 1000 >= w.resetsAt ? 0 : w.pct);
  return Math.max(s.context?.pct ?? 0, current(s.fiveHour), current(s.sevenDay));
}

/** One line for Claude: "context 65% (130k tokens) · 5h 21%, resets Sat 2 AM · 7d 25%, …". */
function describe(s: Snapshot, o: HookOptions): string {
  const now = o.now ?? new Date();
  const limit = (label: string, w?: Window) => {
    if (!w) return null;
    const passed = w.resetsAt > 0 && now.getTime() / 1000 >= w.resetsAt;
    const pct = passed ? 0 : Math.round(w.pct);
    const reset = w.resetsAt > 0 && !passed
      ? `, resets ${formatWhen(new Date(w.resetsAt * 1000), now, o.prefs)} (in ${
        timeLeft(w.resetsAt - now.getTime() / 1000)
      })`
      : "";
    return `${label} ${pct}%${reset}`;
  };
  const parts = [
    s.context && `context ${Math.round(s.context.pct)}% (${Math.round(s.context.tokens / 1000)}k tokens)`,
    limit("5h", s.fiveHour),
    limit("7d", s.sevenDay),
  ].filter(Boolean);
  return parts.length ? `Claude usage, from the user's status bar: ${parts.join(" · ")}` : "";
}

/** What the UserPromptSubmit hook prints for `stdin`; "" when nothing is known. */
export function hookOutput(stdin: string, o: HookOptions): string {
  let input: Json;
  try {
    input = JSON.parse(stdin);
  } catch {
    return "";
  }
  const session = input.session_id ? readJson(snapshotFile(o.sessions, input.session_id)) : null;
  const shared = readUsage(o.usageFile);
  const snapshot = session ?? shared;
  if (!snapshot) return "";
  if (highest(snapshot, o.now ?? new Date()) < (o.from ?? 0)) return "";
  const text = describe(snapshot, o);
  if (!text) return "";
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text },
  });
}

/** Deletes snapshots of sessions untouched for a week. */
export function pruneSnapshots(dir: string, now = Date.now()): void {
  try {
    for (const entry of Deno.readDirSync(dir)) {
      const file = join(dir, entry.name);
      const mtime = Deno.statSync(file).mtime?.getTime() ?? now;
      if (now - mtime > 7 * 86400e3) Deno.removeSync(file);
    }
  } catch {
    // no sessions folder yet
  }
}
