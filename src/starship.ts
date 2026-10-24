// Finding, updating and downloading Starship. A package-managed Starship is
// updated by its package manager; otherwise the latest release is downloaded
// from GitHub (checksum-verified) into the install folder.
import { createHash } from "node:crypto";
import { delimiter, join } from "node:path";
import { installDir, isWindows, paths } from "./paths.ts";

export type Manager = "brew" | "winget" | "scoop" | "ours" | "unknown";

export interface StarshipInfo {
  path: string;
  version: string | null;
  managedBy: Manager;
}

export type UpdatePlan = { kind: "command"; command: string[] } | { kind: "download" } | null;

const RELEASES = "https://api.github.com/repos/starship/starship/releases/latest";

export function parseVersion(output: string): string | null {
  return output.match(/starship\s+v?(\d+\.\d+\.\d+)/)?.[1] ?? null;
}

export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  }
  return 0;
}

export function assetName(os: string, arch: string): string {
  return os === "windows" ? `starship-${arch}-pc-windows-msvc.zip` : `starship-${arch}-apple-darwin.tar.gz`;
}

export function managedBy(path: string, ours = installDir()): Manager {
  const p = path.replaceAll("\\", "/").toLowerCase();
  if (p.startsWith(ours.replaceAll("\\", "/").toLowerCase())) return "ours";
  if (p.includes("/homebrew/") || p.includes("/cellar/") || p === "/usr/local/bin/starship") return "brew";
  if (p.includes("/scoop/")) return "scoop";
  if (p.includes("/program files/starship/")) return "winget";
  return "unknown";
}

export function updatePlan(info: StarshipInfo | null, latest: string): UpdatePlan {
  if (!info?.version) return { kind: "download" };
  if (compareVersions(info.version, latest) >= 0) return null;
  switch (info.managedBy) {
    case "brew":
      return { kind: "command", command: ["brew", "upgrade", "starship"] };
    case "winget":
      return {
        kind: "command",
        command: [
          "winget",
          "upgrade",
          "--id",
          "Starship.Starship",
          "--exact",
          "--silent",
          "--accept-package-agreements",
          "--accept-source-agreements",
        ],
      };
    case "scoop":
      return { kind: "command", command: ["scoop", "update", "starship"] };
    default:
      return { kind: "download" };
  }
}

function versionOf(path: string): string | null {
  try {
    const out = new Deno.Command(path, { args: ["--version"], stdout: "piped", stderr: "null" }).outputSync();
    return out.success ? parseVersion(new TextDecoder().decode(out.stdout)) : null;
  } catch {
    return null;
  }
}

/** The starship on PATH, else one we downloaded earlier. */
export function findStarship(): StarshipInfo | null {
  const exe = isWindows ? "starship.exe" : "starship";
  const candidates = (Deno.env.get("PATH") ?? "").split(delimiter).filter(Boolean).map((d) => join(d, exe));
  candidates.push(paths.starshipDownload());
  for (const path of candidates) {
    try {
      if (!Deno.statSync(path).isFile) continue;
    } catch {
      continue;
    }
    return { path, version: versionOf(path), managedBy: managedBy(path) };
  }
  return null;
}

/**
 * The newest Starship release. Reads where github.com/…/releases/latest redirects
 * (no API rate limit), falling back to the API; gives up after 5 seconds.
 */
export async function latestVersion(): Promise<string> {
  const page = await fetch("https://github.com/starship/starship/releases/latest", {
    method: "HEAD",
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  });
  const tag = page.headers.get("location")?.match(/\/tag\/v?(\d+\.\d+\.\d+)/)?.[1];
  if (tag) return tag;
  const res = await fetch(RELEASES, {
    headers: { Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`GitHub releases: HTTP ${res.status}`);
  return (await res.json()).tag_name.replace(/^v/, "");
}

/** Downloads the latest release into `binDir`, checks its sha256, returns the executable. */
export async function downloadStarship(binDir = join(installDir(), "bin")): Promise<string> {
  const arch = Deno.build.arch === "aarch64" ? "aarch64" : "x86_64";
  const name = assetName(Deno.build.os === "windows" ? "windows" : "darwin", arch);
  const base = "https://github.com/starship/starship/releases/latest/download/";
  const get = async (url: string) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };
  const [archive, sum] = await Promise.all([get(base + name), get(base + name + ".sha256")]);
  const expected = new TextDecoder().decode(sum).trim().split(/\s+/)[0].toLowerCase();
  const actual = createHash("sha256").update(archive).digest("hex");
  if (expected !== actual) throw new Error(`checksum mismatch for ${name}`);

  Deno.mkdirSync(binDir, { recursive: true });
  const archivePath = join(binDir, name);
  Deno.writeFileSync(archivePath, archive);
  // bsdtar ships with macOS and Windows 10+, and reads both .tar.gz and .zip.
  const out = new Deno.Command("tar", { args: ["-xf", archivePath, "-C", binDir] }).outputSync();
  Deno.removeSync(archivePath);
  if (!out.success) throw new Error(`could not extract ${name}: ${new TextDecoder().decode(out.stderr)}`);
  const exe = join(binDir, isWindows ? "starship.exe" : "starship");
  if (!isWindows) Deno.chmodSync(exe, 0o755);
  return exe;
}

export type UninstallPlan = { kind: "command"; command: string[] } | { kind: "delete"; path: string } | null;

/** How to remove Starship: delete our own download, or ask its package manager; null if unknown. */
export function uninstallPlan(info: StarshipInfo): UninstallPlan {
  switch (info.managedBy) {
    case "ours":
      return { kind: "delete", path: info.path };
    case "brew":
      return { kind: "command", command: ["brew", "uninstall", "starship"] };
    case "winget":
      return {
        kind: "command",
        command: ["winget", "uninstall", "--id", "Starship.Starship", "--exact", "--silent"],
      };
    case "scoop":
      return { kind: "command", command: ["scoop", "uninstall", "starship"] };
    default:
      return null;
  }
}

/** Runs a package manager's command, streaming its output. */
export function runUpdate(command: string[]): boolean {
  const out = new Deno.Command(command[0], { args: command.slice(1), stdout: "inherit", stderr: "inherit" })
    .outputSync();
  return out.success;
}
