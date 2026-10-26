// Is there a newer cc-starship? Asked at most once a day, by a background process:
// the status bar and the panel only read the saved answer, so they never wait on the network.
import { dirname } from "node:path";
import { compareVersions } from "./starship.ts";

export const RELEASES = "https://github.com/iFredOS/cc-starship/releases";
const DAY = 24 * 60 * 60 * 1000;

const writeText = (path: string, text: string) => {
  Deno.mkdirSync(dirname(path), { recursive: true });
  Deno.writeTextFileSync(path, text);
};

export interface UpdateCache {
  /** When the last check started (ms). */
  checked: number;
  /** The newest release then; null when there was none to see (the repo is private, say). */
  latest: string | null;
}

export function readUpdateCache(file: string): UpdateCache | null {
  try {
    const c = JSON.parse(Deno.readTextFileSync(file));
    return typeof c?.checked === "number" ? { checked: c.checked, latest: c.latest ?? null } : null;
  } catch {
    return null;
  }
}

/**
 * Saves a check's answer. `latest` undefined means GitHub couldn't be reached: the last
 * version known is kept.
 */
export function saveUpdateCheck(file: string, latest: string | null | undefined, now = Date.now()): void {
  const known = latest === undefined ? readUpdateCache(file)?.latest ?? null : latest;
  writeText(file, JSON.stringify({ checked: now, latest: known }) + "\n");
}

/** The release newer than `current` the last check found, if any. */
export function newerVersion(cache: UpdateCache | null, current: string): string | null {
  return cache?.latest && compareVersions(cache.latest, current) > 0 ? cache.latest : null;
}

/** A day since the last check (or none yet, or a clock set back since). */
export const checkDue = (cache: UpdateCache | null, now = Date.now()) =>
  !cache || now - cache.checked >= DAY || cache.checked > now;

/** A downloaded copy newer than the installed one offers to replace it (never a downgrade). */
export const offerUpdate = (running: string, installed: string | null) =>
  installed !== null && compareVersions(running, installed) > 0;

/** The version a cc-starship program reports, or null when it can't be run. */
export async function versionOf(bin: string): Promise<string | null> {
  try {
    const out = await new Deno.Command(bin, { args: ["--version"], stdout: "piped", stderr: "null" })
      .output();
    return new TextDecoder().decode(out.stdout).trim().match(/^\d+\.\d+\.\d+$/)?.[0] ?? null;
  } catch {
    return null;
  }
}

/** The version in where github.com/…/releases/latest redirects, or null when it shows none. */
export function tagFromLocation(location: string | null): string | null {
  return location?.match(/\/releases\/tag\/v?(\d+\.\d+\.\d+)$/)?.[1] ?? null;
}

/** Asks GitHub for the newest release and saves the answer (undefined when unreachable). */
export async function checkForUpdate(file: string): Promise<string | null> {
  let latest: string | null | undefined;
  try {
    const res = await fetch(`${RELEASES}/latest`, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    latest = tagFromLocation(res.headers.get("location"));
  } catch {
    latest = undefined;
  }
  saveUpdateCheck(file, latest);
  return readUpdateCache(file)?.latest ?? null;
}

/**
 * When a check is due, starts one in a background process (`<bin> check-update`) and
 * returns at once. The due time is moved first, so status bar renders meanwhile don't
 * start more.
 */
export function checkInBackground(file: string, bin: string, now = Date.now()): void {
  const cache = readUpdateCache(file);
  if (!checkDue(cache, now)) return;
  try {
    writeText(file, JSON.stringify({ checked: now, latest: cache?.latest ?? null }) + "\n");
    new Deno.Command(bin, {
      args: ["check-update"],
      stdin: "null",
      stdout: "null",
      stderr: "null",
      detached: true, // or it ends with the status bar render that started it
    }).spawn().unref();
  } catch {
    // no check today; the bar is drawn all the same
  }
}
