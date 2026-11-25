// The shared usage file: "<5h reset> <5h %> <7d reset> <7d %>", one account's latest numbers. A window
// Claude Code didn't send is "0 -" (after a plan upgrade it can send the 7d alone).

export interface UsageWindow {
  resetsAt: number;
  pct: number;
}

export interface Usage {
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
}

// deno-lint-ignore no-explicit-any -- Claude Code's rate_limits windows
type RateWindow = any;

/** The file's line for these windows; "" when neither is known (then the file is left as it is). */
export function usageLine(fiveHour?: RateWindow, sevenDay?: RateWindow): string {
  if (fiveHour?.used_percentage == null && sevenDay?.used_percentage == null) return "";
  return [fiveHour, sevenDay]
    .map((w) => (w?.used_percentage == null ? "0 -" : `${w.resets_at ?? 0} ${Math.round(w.used_percentage)}`))
    .join(" ");
}

/** The windows in a line of the file; null when it isn't one. */
export function parseUsage(text: string): Usage | null {
  const f = text.trim().split(/\s+/);
  if (f.length !== 4) return null;
  const window = (reset: string, pct: string): UsageWindow | undefined | null => {
    if (pct === "-") return undefined;
    const w = { resetsAt: Number(reset), pct: Number(pct) };
    return Number.isNaN(w.resetsAt) || Number.isNaN(w.pct) ? null : w;
  };
  const fiveHour = window(f[0], f[1]);
  const sevenDay = window(f[2], f[3]);
  if (fiveHour === null || sevenDay === null) return null;
  return { fiveHour, sevenDay };
}

/** "✻ 5h 42% · 7d 23%", a window shown as 0% once its reset time has passed; "" when unknown. */
export function usageText(file: string, nowSeconds = Date.now() / 1000): string {
  let usage: Usage | null;
  try {
    usage = parseUsage(Deno.readTextFileSync(file));
  } catch {
    return "";
  }
  if (!usage) return "";
  const current = (label: string, w?: UsageWindow) =>
    w && `${label} ${w.resetsAt > 0 && nowSeconds >= w.resetsAt ? 0 : w.pct}%`;
  const parts = [current("5h", usage.fiveHour), current("7d", usage.sevenDay)].filter(Boolean);
  return parts.length ? `✻ ${parts.join(" · ")}` : "";
}

/** What `cc-starship usage` prints: Starship's segment wants the bare text; a person at a terminal, a whole line. */
export function usageOutput(text: string, terminal: boolean): string {
  return text && terminal ? `${text}\n` : text;
}
