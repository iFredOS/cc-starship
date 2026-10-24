#!/usr/bin/env python3
"""Objective checks for every preset in presets/presets.json.

  contrast   worst WCAG text/background ratio over all bar and shell segments
             (4.5 = comfortable, 3 = readable for short bold labels, below 3 = poor)
  warn       worst contrast of the amber/red warning text on bar line 3
  neighbour  smallest CIE76 delta-E between neighbouring backgrounds (< 10: arrows blur)
  chroma     mean background chroma (0 = all gray)
  twin       closest other preset and the mean delta-E to it (< 8: near duplicate)

Usage: preset_metrics.py [--json out.json]
"""
import json
import math
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
AMBER, RED = "#fabd2f", "#fb4934"


def rgb(h):
    return [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]


def luminance(h):
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb(h)]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def contrast(a, b):
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def lab(h):
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb(h)]
    x = (0.4124 * lin[0] + 0.3576 * lin[1] + 0.1805 * lin[2]) / 0.95047
    y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
    z = (0.0193 * lin[0] + 0.1192 * lin[1] + 0.9505 * lin[2]) / 1.08883
    f = lambda t: t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116
    fx, fy, fz = f(x), f(y), f(z)
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)


def delta_e(a, b):
    return math.dist(lab(a), lab(b))


def segments(p):
    return [s for line in p["bar"]["lines"] for s in line] + p["shell"]["segments"]


def metrics(p, presets):
    segs = segments(p)
    seqs = p["bar"]["lines"] + [p["shell"]["segments"]]
    bgs = [s["bg"] for s in segs]
    twin = min(
        ((q["id"], sum(delta_e(a, b) for a, b in zip(bgs, [s["bg"] for s in segments(q)])) / len(bgs))
         for q in presets if q["id"] != p["id"]),
        key=lambda t: t[1],
    )
    return {
        "id": p["id"], "name": p["name"], "source": p["source"],
        "contrast": round(min(contrast(s["fg"], s["bg"]) for s in segs), 2),
        "low_contrast_segments": sum(contrast(s["fg"], s["bg"]) < 3 for s in segs),
        "warn": round(min(contrast(c, s["bg"]) for c in (AMBER, RED) for s in p["bar"]["lines"][2]), 2),
        "neighbour": round(min(delta_e(a["bg"], b["bg"]) for q in seqs for a, b in zip(q, q[1:])), 1),
        "chroma": round(sum(math.hypot(*lab(b)[1:]) for b in bgs) / len(bgs), 1),
        "twin": twin[0], "twin_delta": round(twin[1], 1),
    }


def main():
    presets = json.loads((ROOT / "presets" / "presets.json").read_text())
    rows = [metrics(p, presets) for p in presets]
    print(f"{'id':<16}{'contrast':>9}{'<3':>4}{'warn':>6}{'neigh':>7}{'chroma':>8}  twin")
    for r in rows:
        print(f"{r['id']:<16}{r['contrast']:>9}{r['low_contrast_segments']:>4}{r['warn']:>6}{r['neighbour']:>7}"
              f"{r['chroma']:>8}  {r['twin']} ({r['twin_delta']})")
    if "--json" in sys.argv:
        pathlib.Path(sys.argv[sys.argv.index("--json") + 1]).write_text(json.dumps(rows, indent=2))


if __name__ == "__main__":
    main()
