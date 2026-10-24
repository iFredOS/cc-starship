#!/usr/bin/env python3
"""Benchmark the oh-my-posh (cc-memento) and Starship Claude Code status bars.

Both bars run against the same payload in a git repository, alternated
round-robin. HOME points at a scratch copy so cc-memento's metrics events,
snapshots and cmux newsfeed pushes don't touch the real state; the compiled
binary (dist/, from `deno task build`) is installed into that scratch home.

Usage: bench.py [runs] [repo]
"""
import json
import os
import pathlib
import platform
import shutil
import statistics
import subprocess
import sys
import tempfile
import time

RUNS = int(sys.argv[1]) if len(sys.argv) > 1 else 100
REPO = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else "~/Developer/1minAI").expanduser()
WARMUP = 10
REAL = pathlib.Path.home()
HERE = pathlib.Path(__file__).resolve().parent
OMP_WRAPPER = REAL / ".claude/cc-memento/bin/statusline.mjs"
OMP_THEME = REAL / ".claude/cc-memento/theme/claude.omp.json"


def scratch_home() -> pathlib.Path:
    home = pathlib.Path(tempfile.mkdtemp(prefix="statusline-bench-"))
    (home / ".claude/cc-memento/theme").mkdir(parents=True)
    (home / ".claude/cc-memento/cache").mkdir()
    shutil.copy(OMP_THEME, home / ".claude/cc-memento/theme/claude.omp.json")
    shutil.copy(REAL / ".claude/settings.json", home / ".claude/settings.json")
    cache = REAL / ".claude/cc-memento/cache/statusline.json"
    if cache.exists():
        shutil.copy(cache, home / ".claude/cc-memento/cache/statusline.json")
    config = json.loads((REAL / ".claude/cc-memento/config.json").read_text())
    config.setdefault("cmux", {}).setdefault("newsfeed", {})["enabled"] = False
    (home / ".claude/cc-memento/config.json").write_text(json.dumps(config))
    email = json.loads((REAL / ".claude.json").read_text()).get("oauthAccount", {}).get("emailAddress", "")
    (home / ".claude.json").write_text(json.dumps({"oauthAccount": {"emailAddress": email}}))
    return home


def payload() -> bytes:
    now = int(time.time())
    return json.dumps({
        "session_id": "bench",
        "cwd": str(REPO),
        "model": {"id": "claude-opus-5-5", "display_name": "Opus 5.5"},
        "workspace": {"current_dir": str(REPO), "project_dir": str(REPO)},
        "version": "2.1.310",
        "cost": {"total_cost_usd": 5.21, "total_duration_ms": 8460000, "total_api_duration_ms": 900000,
                 "total_lines_added": 295, "total_lines_removed": 2},
        "context_window": {"total_input_tokens": 159700, "context_window_size": 1000000, "used_percentage": 16},
        "effort": {"level": "medium"},
        "thinking": {"enabled": True},
        "rate_limits": {"five_hour": {"used_percentage": 1, "resets_at": now + 3600},
                        "seven_day": {"used_percentage": 23, "resets_at": now + 3 * 86400}},
    }).encode()


def install_binary(env) -> pathlib.Path:
    """Installs the compiled binary (deno task build) into the scratch home; returns its install folder."""
    arch = "aarch64" if platform.machine() == "arm64" else "x86_64"
    binary = HERE / "dist" / f"cc-starship-{arch}-apple-darwin"
    if not binary.exists():
        raise SystemExit(f"{binary} not found: run `deno task build` first")
    subprocess.run([str(binary), "install", "--preset", "rainbow", "--no-starship-update"],
                   env={**env, "CC_STARSHIP_PROFILES": ""}, check=True, capture_output=True)
    return pathlib.Path(env["HOME"]) / ".local/share/cc-starship"


def main() -> None:
    home = scratch_home()
    env = {**os.environ, "HOME": str(home)}
    for key in ("CLAUDE_CONFIG_DIR", "STARSHIP_CONFIG", "CC_STARSHIP_HOME"):
        env.pop(key, None)
    installed = install_binary(env)
    data = payload()
    commands = {
        "oh-my-posh bar (full)": ["node", str(OMP_WRAPPER)],
        "Starship bar (full)": [str(installed / "bin/cc-starship"), "statusline"],
        "  node startup only": ["node", "-e", ""],
        "  oh-my-posh claude only": ["oh-my-posh", "claude", "--config", str(OMP_THEME)],
        "  starship prompt only": ["env", f"STARSHIP_CONFIG={installed / 'statusline.toml'}", "STARSHIP_SHELL=",
                                   "starship", "prompt"],
        "  git status only": ["git", "status", "--branch", "--porcelain", "--untracked-files=no"],
        "  shell usage segment": [str(installed / "bin/cc-starship"), "usage"],
    }
    silent = {"  node startup only", "  git status only", "  shell usage segment"}

    def run(name, cmd):
        start = time.perf_counter_ns()
        proc = subprocess.run(cmd, input=data, cwd=REPO, env=env, capture_output=True)
        elapsed = (time.perf_counter_ns() - start) / 1e6
        if proc.returncode != 0 or not proc.stdout.strip() and name not in silent:
            raise SystemExit(f"{cmd} failed ({proc.returncode}): {proc.stderr.decode()[:300]}")
        return elapsed

    for _ in range(WARMUP):
        for name, cmd in commands.items():
            run(name, cmd)
    samples = {name: [] for name in commands}
    for _ in range(RUNS):
        for name, cmd in commands.items():
            samples[name].append(run(name, cmd))
    shutil.rmtree(home)

    rows = []
    for name, ms in samples.items():
        ms.sort()
        rows.append({
            "name": name, "mean": statistics.fmean(ms), "median": statistics.median(ms),
            "p95": ms[int(len(ms) * 0.95) - 1], "min": ms[0], "max": ms[-1], "stdev": statistics.stdev(ms),
        })

    header = f"{'command':<28}{'mean':>9}{'median':>9}{'p95':>9}{'min':>9}{'max':>9}{'stdev':>8}   (ms, n={RUNS})"
    lines = [header] + [
        f"{r['name']:<28}{r['mean']:>9.1f}{r['median']:>9.1f}{r['p95']:>9.1f}{r['min']:>9.1f}{r['max']:>9.1f}{r['stdev']:>8.1f}"
        for r in rows
    ]
    omp, star = rows[0]["median"], rows[1]["median"]
    faster, slower = ("Starship", "oh-my-posh") if star < omp else ("oh-my-posh", "Starship")
    lines.append(f"\nmedian: {faster} is {max(omp, star) / min(omp, star):.2f}x faster than {slower} "
                 f"({abs(omp - star):.1f} ms per refresh)")
    report = "\n".join(lines)
    print(report)
    stamp = time.strftime("%Y-%m-%dT%H-%M-%S")
    out = HERE / "bench-results"
    out.mkdir(exist_ok=True)
    (out / f"{stamp}.json").write_text(json.dumps({"runs": RUNS, "repo": str(REPO), "rows": rows}, indent=2))
    (out / f"{stamp}.txt").write_text(report + "\n")


if __name__ == "__main__":
    main()
