// Which build this is: the version (set here, the one place), plus the build number, commit and
// commit date that `deno task build` writes to dist/build.json and embeds in the binary.
// Shown by --version as one line for bug reports: cc-starship 1.3.0 (176 · fae1f44) release · macOS 27.3 arm64

export const VERSION = "1.3.3";

export interface BuildInfo {
  version: string;
  /** `git rev-list --count HEAD` at build time; null when unknown. */
  build: number | null;
  /** Short commit, with `-modified` when the tree had changes; null when unknown. */
  commit: string | null;
  /** The commit's date (seconds), not the build's: the same commit always builds the same. */
  date: number | null;
}

/** Build info from the text of dist/build.json (null: no file); anything unreadable is unknown. */
export function buildInfo(text: string | null): BuildInfo {
  const unknown = { version: VERSION, build: null, commit: null, date: null };
  if (text === null) return unknown;
  try {
    const j = JSON.parse(text);
    if (!Number.isInteger(j?.build) || typeof j?.commit !== "string") return unknown;
    return {
      version: VERSION,
      build: j.build,
      commit: j.commit,
      date: Number.isInteger(j.date) ? j.date : null,
    };
  } catch {
    return unknown;
  }
}

export interface Host {
  os: string;
  osVersion: string;
  arch: string;
}

/** The one-line identity of a build. */
export function versionLine(info: BuildInfo, kind: "release" | "dev", host: Host): string {
  return `cc-starship ${info.version} (${info.build ?? "unknown"} · ${info.commit ?? "unknown"}) ${kind} · ` +
    `${host.os} ${host.osVersion} ${host.arch}`;
}

/** This program's build info, embedded by the build; unknown when run from source (dist/ may be stale). */
export function currentBuild(): BuildInfo {
  if (releaseKind() === "dev") return buildInfo(null);
  try {
    return buildInfo(Deno.readTextFileSync(new URL("../dist/build.json", import.meta.url)));
  } catch {
    return buildInfo(null);
  }
}

/** The system this runs on, in the words people use: "macOS 27.3", "Windows 10.0.26100". */
export function currentHost(): Host {
  const arch = Deno.build.arch === "aarch64" ? "arm64" : Deno.build.arch;
  if (Deno.build.os === "darwin") {
    let v = Deno.osRelease();
    try {
      const out = new Deno.Command("sw_vers", { args: ["-productVersion"], stdout: "piped", stderr: "null" })
        .outputSync();
      if (out.success) v = new TextDecoder().decode(out.stdout).trim();
    } catch {
      // keep the kernel version
    }
    return { os: "macOS", osVersion: v, arch };
  }
  return { os: Deno.build.os === "windows" ? "Windows" : Deno.build.os, osVersion: Deno.osRelease(), arch };
}

/** A built binary (`deno compile`), whatever its file is called, rather than `deno run` from source. */
export const releaseKind = (): "release" | "dev" => (Deno.build.standalone ? "release" : "dev");
