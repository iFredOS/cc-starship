#!/usr/bin/env python3
"""One-off import of the 38 themes from the Windows statusline-command.ps1
(C:\\Users\\you\\.claude) into presets/presets.json, next to the built-in
rainbow and gray presets.

Each PowerShell theme gives a background and text color to seven roles:
model (m), version (v), directory (d), git (g), context (cx, text always cream),
status (st) and cost (c). Neighbouring segments must not share a background or
the arrow between them vanishes, and the v2 themes alternate two backgrounds,
so roles are placed by position in sequences that keep that alternation:

  bar line 1: m v d g    bar line 2: d g c    bar line 3: cx st c v
  shell:      m v d g c st   (user, directory, git, languages, env, duration)

Usage: import_ps1_themes.py <statusline-command.ps1>
"""
import json
import pathlib
import re
import sys

CREAM = (250, 249, 245)
BAR_LINES = [["m", "v", "d", "g"], ["d", "g", "c"], ["cx", "st", "c", "v"]]
SHELL = ["m", "v", "d", "g", "c", "st"]
HERE = pathlib.Path(__file__).resolve().parent.parent


def hexa(rgb):
    return "#" + "".join(f"{c:02x}" for c in rgb)


def pair(bg, fg):
    return {"bg": bg, "fg": fg}


def builtin(id_, name, accent, text, bar, shell):
    return {
        "id": id_, "name": name, "source": "built-in",
        "bar": {"accent": accent, "lines": [[pair(bg, text) for bg in line] for line in bar]},
        "shell": {"segments": [pair(bg, text) for bg in shell]},
    }


BUILTINS = [
    builtin("rainbow", "Rainbow", "#fbf1c7", "#fbf1c7",
            [["#d65d0e", "#d79921", "#689d6a", "#458588"], ["#d79921", "#689d6a", "#458588"],
             ["#665c54", "#504945", "#3c3836", "#32302f"]],
            ["#d65d0e", "#d79921", "#689d6a", "#458588", "#665c54", "#3c3836"]),
    builtin("gray", "Gray", "#d78770", "#ebdbb2",
            [["#282828", "#3d3937", "#514b45", "#665c54"], ["#282828", "#47423e", "#665c54"],
             ["#3c3836", "#504945", "#665c54", "#7c6f64"]],
            ["#282828", "#3c3836", "#47423e", "#504945", "#665c54", "#3c3836"]),
]


def parse(ps1):
    colors = {m[1]: tuple(map(int, m.groups()[1:])) for m in re.finditer(r"\$(\w+)=@\((\d+),(\d+),(\d+)\)", ps1)}
    block = ps1[ps1.index("$schemes = @("):]
    themes = []
    for line in re.findall(r"@\{ name='[^']+';.*?\}(?=,?\s*$)", block, re.M):
        name = re.search(r"name='([^']+)'", line)[1]
        fields = {}
        for key, val in re.findall(r"(\w+)=(\$\w+|@\(\d+,\d+,\d+\))", line):
            fields[key] = colors[val[1:]] if val.startswith("$") else tuple(map(int, re.findall(r"\d+", val)))
        fields.setdefault("cxFg", CREAM)
        themes.append((name, fields))
    return themes


def separate(segments):
    """Lightens a background that matches its left neighbour, so the arrow shows."""
    for left, right in zip(segments, segments[1:]):
        if left["bg"] == right["bg"]:
            rgb = [int(right["bg"][i:i + 2], 16) for i in (1, 3, 5)]
            right["bg"] = hexa(min(255, c + 24) for c in rgb)
    return segments


def convert(name, f):
    role = lambda r: pair(hexa(f[f"{r}Bg"]), hexa(f[f"{r}Fg"]))
    return {
        "id": re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-"),
        "name": name, "source": "windows-statusline",
        "bar": {"accent": hexa(f["mFg"]), "lines": [separate([role(r) for r in line]) for line in BAR_LINES]},
        "shell": {"segments": separate([role(r) for r in SHELL])},
    }


# Shipped presets, after a design review of all 40 (contrast, separation,
# duplicates): the 11 recommended plus 4 alternates, grouped by look.
KEEP = [
    "rainbow", "sunset-v1", "autumn", "ocean-v1", "jewel", "mocha-v1", "nord-v1", "berry", "tidepool",
    "synthwave", "gray", "neon", "ice", "ember", "tokyo-night",
]

# Review fixes, as {preset: {old background: new background}}.
FIXES = {
    # Cream text on gruvbox yellow/aqua was 2.2:1 and 2.8:1; gruvbox's deeper tones keep it cream.
    "rainbow": {"#d79921": "#a86b10", "#689d6a": "#427b58"},
    # Near-black segments vanished against a dark terminal, taking their rounded caps with them.
    "gray": {"#282828": "#32302f"},
    "ocean-v1": {"#071e37": "#0d3b66"},
    "mocha-v1": {"#181825": "#313244", "#1e1e2e": "#313244"},
}


def apply_fixes(p):
    fixes = FIXES.get(p["id"], {})
    for seq in p["bar"]["lines"] + [p["shell"]["segments"]]:
        for s in seq:
            s["bg"] = fixes.get(s["bg"], s["bg"])
    return p


def main():
    themes = parse(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
    taken = {p["id"] for p in BUILTINS}
    imported = [convert(n, f) for n, f in themes]
    for p in imported:  # e.g. the Windows "Rainbow" vs the built-in gruvbox-rainbow
        if p["id"] in taken:
            p["id"] += "-classic"
            p["name"] += " Classic"
    by_id = {p["id"]: p for p in BUILTINS + imported}
    presets = [apply_fixes(by_id[i]) for i in KEEP]
    ids = [p["id"] for p in presets]
    assert len(ids) == len(set(ids)), "duplicate preset ids"
    out = HERE / "presets" / "presets.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(presets, indent=2) + "\n")
    print(f"{len(presets)} of {len(themes) + len(BUILTINS)} presets kept -> {out}")


if __name__ == "__main__":
    main()
