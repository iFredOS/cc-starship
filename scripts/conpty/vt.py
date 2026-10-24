#!/usr/bin/env python3
"""Replays a ConPTY capture (output.raw + timeline.tsv from harness.ps1) through a small VT
emulator and cuts it into frames: the screen just before each key the script sent, at each
`mark`, when the child exited, and after the pseudo console closed.

ConPTY does not forward the program's own bytes: conhost renders into its buffer and re-emits
the *differences* as VT. So frames cannot be found by splitting on the app's `ESC[H ESC[2J`;
the screen has to be emulated. (The split count is still reported, as a diagnostic.)

usage: vt.py RUN_DIR [--all] [--frame N|last] [--quiet] [--no-dedup] [--exact] [--png N|last|all]

Writes RUN_DIR/frames/NN.txt (plain, exact glyphs), NN.ansi (24-bit SGR, for ansi2html.py) and
index.tsv. Prints a summary and the last frame (or every frame with --all) as plain text, with
Nerd Font (Private Use Area) glyphs shown as "¤" so column alignment survives any viewer;
--exact prints the real glyphs.
"""
import codecs
import copy
import json
import os
import re
import subprocess
import sys
import unicodedata

# Windows "Campbell" scheme: how conhost / Windows Terminal show the 16 indexed colors.
CAMPBELL = ["#0c0c0c", "#c50f1f", "#13a10e", "#c19c00", "#0037da", "#881798", "#3a96dd", "#cccccc",
            "#767676", "#e74856", "#16c60c", "#f9f1a5", "#3b78ff", "#b4009e", "#61d6d6", "#f2f2f2"]
DEFAULT_FG, DEFAULT_BG = "#ebdbb2", "#1d2021"  # ansi2html.py's window colors
BLANK_ATTR = (None, None, False, False, False, False, False)  # fg, bg, bold, dim, italic, underline, reverse


def width(ch):
    if not ch:
        return 0
    o = ord(ch[0])
    if o < 0x20 or 0x7f <= o < 0xa0:
        return 0
    if unicodedata.combining(ch[0]) or o in (0x200b, 0x200c, 0x200d, 0xfe0e, 0xfe0f):
        return 0
    # Nerd Font glyphs live in the Private Use Area: conhost gives them one cell.
    return 2 if unicodedata.east_asian_width(ch[0]) in ("W", "F") else 1


def color256(n):
    if n < 16:
        return CAMPBELL[n]
    if n < 232:
        n -= 16
        steps = [0, 95, 135, 175, 215, 255]
        return "#%02x%02x%02x" % (steps[n // 36], steps[(n // 6) % 6], steps[n % 6])
    g = 8 + (n - 232) * 10
    return "#%02x%02x%02x" % (g, g, g)


class Screen:
    def __init__(self, cols, rows):
        self.cols, self.rows = cols, rows
        self.main = self._blank_grid()
        self.alt = self._blank_grid()
        self.in_alt = False
        self.x = self.y = 0
        self.pending_wrap = False
        self.attr = BLANK_ATTR
        self.top, self.bottom = 0, rows - 1
        self.saved = (0, 0, BLANK_ATTR)
        self.saved_main = (0, 0, BLANK_ATTR)
        self.cursor_visible = True
        self.autowrap = True
        self.title = ""
        self.modes = {}  # private modes seen: number -> bool
        self.state, self.buf = "ground", ""

    # ── grid helpers ────────────────────────────────────────────────────────
    def _blank_row(self, attr=BLANK_ATTR):
        a = (None, attr[1], False, False, False, False, False)
        return [[" ", a] for _ in range(self.cols)]

    def _blank_grid(self):
        return [self._blank_row() for _ in range(self.rows)]

    @property
    def grid(self):
        return self.alt if self.in_alt else self.main

    def resize(self, cols, rows):
        for name in ("main", "alt"):
            g = getattr(self, name)
            g = [r[:cols] + [[" ", BLANK_ATTR] for _ in range(cols - len(r))] for r in g]
            if rows < len(g):
                g = g[len(g) - rows:] if name == "main" else g[:rows]
            g += [[[" ", BLANK_ATTR] for _ in range(cols)] for _ in range(rows - len(g))]
            setattr(self, name, g)
        self.cols, self.rows = cols, rows
        self.top, self.bottom = 0, rows - 1
        self.x, self.y = min(self.x, cols - 1), min(self.y, rows - 1)

    def _erase_attr(self):
        return (None, self.attr[1], False, False, False, False, False)

    def _clear_cells(self, y, x0, x1):
        a = self._erase_attr()
        row = self.grid[y]
        for x in range(max(0, x0), min(self.cols, x1)):
            row[x] = [" ", a]

    def _scroll_up(self, n=1, top=None, bottom=None):
        top = self.top if top is None else top
        bottom = self.bottom if bottom is None else bottom
        g = self.grid
        for _ in range(n):
            del g[top]
            g.insert(bottom, self._blank_row(self.attr))

    def _scroll_down(self, n=1, top=None, bottom=None):
        top = self.top if top is None else top
        bottom = self.bottom if bottom is None else bottom
        g = self.grid
        for _ in range(n):
            del g[bottom]
            g.insert(top, self._blank_row(self.attr))

    def _index(self):
        if self.y == self.bottom:
            self._scroll_up()
        elif self.y < self.rows - 1:
            self.y += 1

    def _move(self, x=None, y=None):
        if x is not None:
            self.x = max(0, min(self.cols - 1, x))
        if y is not None:
            self.y = max(0, min(self.rows - 1, y))
        self.pending_wrap = False

    # ── input ───────────────────────────────────────────────────────────────
    def feed(self, text):
        for ch in text:
            s = self.state
            if s == "ground":
                if ch == "\x1b":
                    self.state, self.buf = "esc", ""
                elif ch < " " or ch == "\x7f":
                    self._control(ch)
                else:
                    self._print(ch)
            elif s == "esc":
                self._esc(ch)
            elif s == "csi":
                if "\x40" <= ch <= "\x7e":
                    self.state = "ground"
                    self._csi(self.buf, ch)
                elif ch == "\x1b":
                    self.state, self.buf = "esc", ""
                else:
                    self.buf += ch
            elif s in ("osc", "dcs"):
                if ch == "\x07":
                    self._osc_end()
                elif ch == "\x1b":
                    self.state = s + "-esc"
                else:
                    self.buf += ch
            elif s in ("osc-esc", "dcs-esc"):
                self._osc_end()  # ESC \ terminates; anything else: drop it too
            elif s == "charset":
                self.state = "ground"

    def _osc_end(self):
        if self.state.startswith("osc"):
            num, _, rest = self.buf.partition(";")
            if num in ("0", "2"):
                self.title = rest
        self.state, self.buf = "ground", ""

    def _control(self, ch):
        if ch == "\r":
            self._move(x=0)
        elif ch in "\n\x0b\x0c":
            self.pending_wrap = False
            self._index()
        elif ch == "\b":
            self._move(x=self.x - 1)
        elif ch == "\t":
            self._move(x=min(self.cols - 1, (self.x // 8 + 1) * 8))

    def _print(self, ch):
        w = width(ch)
        g = self.grid
        if w == 0:
            px = self.x - 1 if not self.pending_wrap else self.x
            if 0 <= px < self.cols and g[self.y][px][0] not in ("", " "):
                g[self.y][px][0] += ch
            return
        if self.pending_wrap and self.autowrap:
            self.x = 0
            self._index()
            self.pending_wrap = False
        if w == 2 and self.x == self.cols - 1:
            if self.autowrap:
                g[self.y][self.x] = [" ", self.attr]
                self.x = 0
                self._index()
            else:
                return
        row = self.grid[self.y]
        # Overwriting half of a wide char blanks its other half.
        if row[self.x][0] == "" and self.x > 0:
            row[self.x - 1] = [" ", row[self.x - 1][1]]
        row[self.x] = [ch, self.attr]
        if w == 2:
            row[self.x + 1] = ["", self.attr]
        if self.x + w < self.cols and row[self.x + w][0] == "":
            row[self.x + w] = [" ", row[self.x + w][1]]
        if self.x + w >= self.cols:
            self.x = self.cols - 1
            self.pending_wrap = True
        else:
            self.x += w

    def _esc(self, ch):
        self.state = "ground"
        if ch == "[":
            self.state, self.buf = "csi", ""
        elif ch == "]":
            self.state, self.buf = "osc", ""
        elif ch in "P_^X":
            self.state, self.buf = "dcs", ""
        elif ch in "()*+-./":
            self.state = "charset"
        elif ch == "7":
            self.saved = (self.x, self.y, self.attr)
        elif ch == "8":
            self.x, self.y, self.attr = self.saved
            self.pending_wrap = False
        elif ch == "D":
            self._index()
        elif ch == "E":
            self._move(x=0)
            self._index()
        elif ch == "M":
            if self.y == self.top:
                self._scroll_down()
            else:
                self._move(y=self.y - 1)
        elif ch == "c":
            self.__init__(self.cols, self.rows)

    def _csi(self, raw, final):
        private = raw[:1] if raw[:1] in "?<=>" else ""
        body = raw[len(private):].rstrip(" !\"#$%&'()*+,-./")
        intermediate = raw[len(private) + len(body):]
        try:
            ps = [int(p) if p else 0 for p in re.split("[;:]", body)] if body else []
        except ValueError:
            return
        p0 = ps[0] if ps else 0
        n = p0 or 1
        if intermediate:
            return  # DECSCUSR (" q") etc.: cursor style, not content
        if private == "?" and final in "hl":
            on = final == "h"
            for m in ps:
                self.modes[m] = on
                if m == 25:
                    self.cursor_visible = on
                elif m == 7:
                    self.autowrap = on
                elif m in (47, 1047, 1049):
                    if on and not self.in_alt:
                        self.saved_main = (self.x, self.y, self.attr)
                        self.in_alt = True
                        self.alt = self._blank_grid()
                    elif not on and self.in_alt:
                        self.in_alt = False
                        if m == 1049:
                            self.x, self.y, self.attr = self.saved_main
            return
        if private:
            return
        if final == "m":
            self._sgr(ps or [0])
        elif final == "A":
            self._move(y=max(self.top if self.y >= self.top else 0, self.y - n))
        elif final == "B":
            self._move(y=min(self.bottom if self.y <= self.bottom else self.rows - 1, self.y + n))
        elif final == "C":
            self._move(x=self.x + n)
        elif final == "D":
            self._move(x=self.x - n)
        elif final == "E":
            self._move(x=0, y=self.y + n)
        elif final == "F":
            self._move(x=0, y=self.y - n)
        elif final in "G`":
            self._move(x=n - 1)
        elif final == "d":
            self._move(y=n - 1)
        elif final in "Hf":
            row = ps[0] if len(ps) > 0 and ps[0] else 1
            col = ps[1] if len(ps) > 1 and ps[1] else 1
            self._move(x=col - 1, y=row - 1)
        elif final == "J":
            if p0 == 0:
                self._clear_cells(self.y, self.x, self.cols)
                for y in range(self.y + 1, self.rows):
                    self._clear_cells(y, 0, self.cols)
            elif p0 == 1:
                for y in range(0, self.y):
                    self._clear_cells(y, 0, self.cols)
                self._clear_cells(self.y, 0, self.x + 1)
            elif p0 in (2, 3):
                for y in range(self.rows):
                    self._clear_cells(y, 0, self.cols)
        elif final == "K":
            if p0 == 0:
                self._clear_cells(self.y, self.x, self.cols)
            elif p0 == 1:
                self._clear_cells(self.y, 0, self.x + 1)
            elif p0 == 2:
                self._clear_cells(self.y, 0, self.cols)
        elif final == "X":
            self._clear_cells(self.y, self.x, self.x + n)
        elif final == "P":
            row = self.grid[self.y]
            a = self._erase_attr()
            del row[self.x:self.x + n]
            row.extend([[" ", a] for _ in range(self.cols - len(row))])
        elif final == "@":
            row = self.grid[self.y]
            a = self._erase_attr()
            for _ in range(n):
                row.insert(self.x, [" ", a])
            del row[self.cols:]
        elif final == "L":
            if self.top <= self.y <= self.bottom:
                self._scroll_down(n, top=self.y)
        elif final == "M":
            if self.top <= self.y <= self.bottom:
                self._scroll_up(n, top=self.y)
        elif final == "S":
            self._scroll_up(n)
        elif final == "T":
            self._scroll_down(n)
        elif final == "r":
            top = (ps[0] if len(ps) > 0 and ps[0] else 1) - 1
            bottom = (ps[1] if len(ps) > 1 and ps[1] else self.rows) - 1
            if top < bottom:
                self.top, self.bottom = top, min(bottom, self.rows - 1)
                self._move(x=0, y=0)
        elif final == "s":
            self.saved = (self.x, self.y, self.attr)
        elif final == "u":
            self.x, self.y, self.attr = self.saved
            self.pending_wrap = False

    def _sgr(self, ps):
        fg, bg, bold, dim, italic, ul, rev = self.attr
        i = 0
        while i < len(ps):
            c = ps[i]
            if c == 0:
                fg, bg, bold, dim, italic, ul, rev = BLANK_ATTR
            elif c == 1:
                bold = True
            elif c == 2:
                dim = True
            elif c == 3:
                italic = True
            elif c == 4:
                ul = True
            elif c == 7:
                rev = True
            elif c == 22:
                bold = dim = False
            elif c == 23:
                italic = False
            elif c == 24:
                ul = False
            elif c == 27:
                rev = False
            elif 30 <= c <= 37:
                fg = CAMPBELL[c - 30]
            elif 90 <= c <= 97:
                fg = CAMPBELL[c - 90 + 8]
            elif 40 <= c <= 47:
                bg = CAMPBELL[c - 40]
            elif 100 <= c <= 107:
                bg = CAMPBELL[c - 100 + 8]
            elif c == 39:
                fg = None
            elif c == 49:
                bg = None
            elif c in (38, 48) and i + 1 < len(ps):
                if ps[i + 1] == 5 and i + 2 < len(ps):
                    col = color256(ps[i + 2])
                    i += 2
                elif ps[i + 1] == 2 and i + 4 < len(ps):
                    col = "#%02x%02x%02x" % tuple(min(255, v) for v in ps[i + 2:i + 5])
                    i += 4
                else:
                    col = None
                    i += 1
                if c == 38:
                    fg = col
                else:
                    bg = col
            i += 1
        self.attr = (fg, bg, bold, dim, italic, ul, rev)

    # ── output ──────────────────────────────────────────────────────────────
    def snapshot(self):
        return {
            "grid": [[(c[0], c[1]) for c in row] for row in self.grid],
            "alt": self.in_alt, "cursor": (self.x, self.y), "cursor_visible": self.cursor_visible,
            "title": self.title, "cols": self.cols, "rows": self.rows,
        }


def plain_rows(snap):
    return ["".join(c[0] for c in row).rstrip() for row in snap["grid"]]


def ansi_rows(snap):
    """Re-serialize a frame as 24-bit SGR that ansi2html.py understands (reverse resolved)."""
    lines = []
    for row in snap["grid"]:
        # drop trailing default blanks
        end = len(row)
        while end and row[end - 1][0] in (" ", "") and row[end - 1][1][1] is None and not row[end - 1][1][6]:
            end -= 1
        out, cur = [], None
        for ch, a in row[:end]:
            if ch == "":
                continue
            fg, bg, bold, dim, _it, _ul, rev = a
            if rev:
                fg, bg = (bg or DEFAULT_BG), (fg or DEFAULT_FG)
            key = (fg, bg, bold, dim)
            if key != cur:
                codes = ["0"]
                if bold:
                    codes.append("1")
                if dim:
                    codes.append("2")
                if fg:
                    codes.append("38;2;%d;%d;%d" % tuple(int(fg[k:k + 2], 16) for k in (1, 3, 5)))
                if bg:
                    codes.append("48;2;%d;%d;%d" % tuple(int(bg[k:k + 2], 16) for k in (1, 3, 5)))
                out.append("\x1b[%sm" % ";".join(codes))
                cur = key
            out.append(ch)
        out.append("\x1b[0m")
        lines.append("".join(out))
    while lines and lines[-1] == "\x1b[0m":
        lines.pop()
    return lines


def read_timeline(path):
    events = []
    with open(path, encoding="utf-8", errors="replace") as f:
        next(f, None)
        for line in f:
            parts = line.rstrip("\n").split("\t", 3)
            if len(parts) < 3:
                continue
            ms, off, kind = int(parts[0]), int(parts[1]), parts[2]
            events.append((ms, off, kind, parts[3] if len(parts) > 3 else ""))
    return events


def frames_for(run):
    raw = open(os.path.join(run, "output.raw"), "rb").read()
    result = json.load(open(os.path.join(run, "result.json"), encoding="utf-8-sig"))
    events = read_timeline(os.path.join(run, "timeline.tsv"))
    cols, rows = int(result.get("cols", 120)), int(result.get("rows", 40))
    scr = Screen(cols, rows)
    dec = codecs.getincrementaldecoder("utf-8")("replace")
    pos, frames = 0, []

    def advance(to):
        nonlocal pos
        if to > pos:
            scr.feed(dec.decode(raw[pos:to]))
            pos = to

    for ms, off, kind, detail in events:
        label = None
        if kind == "send" and not detail.startswith("reply("):
            label = "before " + detail
        elif kind == "mark":
            label = "mark " + detail
        elif kind == "exit":
            label = "child exited (code %s)" % detail
        elif kind == "resize":
            advance(off)
            c, r = detail.split()[0].split("x")
            scr.resize(int(c), int(r))
            continue
        if label:
            advance(off)
            frames.append(dict(scr.snapshot(), label=label, ms=ms, offset=off))
    advance(len(raw))
    scr.feed(dec.decode(b"", final=True))
    frames.append(dict(scr.snapshot(), label="final (pseudo console closed)",
                       ms=events[-1][0] if events else 0, offset=len(raw)))
    return raw, result, events, frames


def dedup(frames):
    out = []
    for f in frames:
        if out and out[-1]["grid"] == f["grid"] and out[-1]["alt"] == f["alt"]:
            out[-1]["label"] += " | " + f["label"]
            out[-1]["dups"] = out[-1].get("dups", 1) + 1
            continue
        out.append(f)
    return out


def header(i, n, f):
    return "=== frame %d/%d @ %.2fs  off %d  %s  [%dx%d %s, cursor %s %s] ===" % (
        i, n, f["ms"] / 1000, f["offset"], f["label"], f["cols"], f["rows"],
        "alt" if f["alt"] else "main", "%d,%d" % (f["cursor"][0] + 1, f["cursor"][1] + 1),
        "shown" if f["cursor_visible"] else "hidden")


PUA_MARK = "¤"


def is_pua(ch):
    o = ord(ch[0]) if ch else 0
    return 0xE000 <= o <= 0xF8FF or o >= 0xF0000


def render_text(f, exact=True):
    rows = plain_rows(f)
    if not exact:
        # Nerd Font glyphs are one cell in conhost, but most viewers draw them zero-width or not
        # at all, which makes correct rows look short. Show them as a visible one-cell mark.
        rows = ["".join(PUA_MARK if is_pua(c) else c for c in r) for r in rows]
    last = max((i for i, r in enumerate(rows) if r), default=-1)
    body = rows[:last + 1]
    blank = len(rows) - len(body)
    return "\n".join(body) + ("\n(%d blank rows below)" % blank if blank else "")


def summary(raw, result, events, frames, run):
    exit_off = next((o for _, o, k, _ in events if k == "exit"), None)
    kinds = [k for _, _, k, _ in events]
    first_chunk = next((ms for ms, _, k, _ in events if k == "chunk"), None)
    code = result.get("exitCode")
    if isinstance(code, int) and code > 0xFFFF:
        code = "%d (0x%08X%s)" % (code, code, ", harness timeout kill" if code == 0xC0DE0124 else "")
    lines = [
        "run: %s" % run,
        "command: %s  (%sx%s)" % (result.get("commandLine"), result.get("cols"), result.get("rows")),
        "exit code: %s  timed out: %s  duration: %s ms  bytes: %d  first output after: %s ms" % (
            code, result.get("timedOut"), result.get("durationMs"), len(raw), first_chunk),
        "processes in job: %s total, %s still running after child exit" % (
            result.get("jobTotalProcesses"), result.get("jobActiveAfterExit")),
        "bytes after child exit: %s" % ("?" if exit_off is None else len(raw) - exit_off),
        "app-level clears (ESC[H ESC[2J) seen verbatim: %d; ?1049h/l seen: %d/%d" % (
            raw.count(b"\x1b[H\x1b[2J"), raw.count(b"\x1b[?1049h"), raw.count(b"\x1b[?1049l")),
    ]
    for kind in ("waittext-timeout", "step-skipped", "step-error", "step-crash", "send-failed", "timeout"):
        if kind in kinds:
            lines.append("!! %s: %s" % (kind, "; ".join(d for _, _, k, d in events if k == kind)))
    replies = [d for _, _, k, d in events if k == "send" and d.startswith("reply(")]
    if replies:
        lines.append("auto-replies: %s" % ", ".join(replies))
    lines.append("frames: %d (after merging identical neighbours)" % len(frames))
    return "\n".join(lines)


def main(argv):
    args = argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    run = args.pop(0)
    show_all = "--all" in args
    quiet = "--quiet" in args
    no_dedup = "--no-dedup" in args
    exact = "--exact" in args
    pick = args[args.index("--frame") + 1] if "--frame" in args else None
    png = args[args.index("--png") + 1] if "--png" in args else None

    raw, result, events, frames = frames_for(run)
    if not no_dedup:
        frames = dedup(frames)
    out = os.path.join(run, "frames")
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "index.tsv"), "w", encoding="utf-8") as idx:
        idx.write("frame\tms\toffset\tscreen\tlabel\n")
        for i, f in enumerate(frames, 1):
            with open(os.path.join(out, "%02d.txt" % i), "w", encoding="utf-8") as t:
                t.write(header(i, len(frames), f) + "\n" + render_text(f) + "\n")
            with open(os.path.join(out, "%02d.ansi" % i), "w", encoding="utf-8") as a:
                a.write("\n".join(ansi_rows(f)) + "\n")
            idx.write("%d\t%d\t%d\t%s\t%s\n" % (i, f["ms"], f["offset"], "alt" if f["alt"] else "main", f["label"]))

    print(summary(raw, result, events, frames, run))
    print("frames written to %s" % out)
    if not quiet:
        if show_all:
            chosen = range(1, len(frames) + 1)
        elif pick in (None, "last"):
            chosen = [len(frames)]
            # A TUI that exits leaves a blank (or shell) screen: also show the last frame with content.
            if not any(plain_rows(frames[-1])):
                drawn = [i for i, f in enumerate(frames, 1) if any(plain_rows(f))]
                if drawn:
                    chosen = [drawn[-1], len(frames)]
        else:
            chosen = [int(pick)]
        for i in chosen:
            f = frames[i - 1]
            print()
            print(header(i, len(frames), f))
            print(render_text(f, exact))
        if not exact:
            print("\n(Nerd Font glyphs shown as %s, one cell each; --exact prints them)" % PUA_MARK)
        if not show_all and len(frames) > 1:
            print("(%d frames; --all prints every one, frames/index.tsv lists them)" % len(frames))
    sys.stdout.flush()
    if png:
        here = os.path.dirname(os.path.abspath(__file__))
        targets = range(1, len(frames) + 1) if png == "all" else [len(frames) if png == "last" else int(png)]
        for i in targets:
            render_png(here, out, i, "%s  ·  frame %d: %s" % (os.path.basename(run.rstrip("/")), i, frames[i - 1]["label"]))
    return 0


def render_png(here, out, i, title):
    shots = os.path.join(os.path.dirname(here), "screenshots")
    cache = os.path.join(os.environ.get("TMPDIR", "/tmp"), "ccs-conpty-snap")
    snap = os.path.join(cache, "snap")
    os.makedirs(cache, exist_ok=True)
    src = os.path.join(shots, "snap.swift")
    if not os.path.exists(snap) or os.path.getmtime(snap) < os.path.getmtime(src):
        subprocess.run(["swiftc", "-O", src, "-o", snap], check=True, stderr=subprocess.DEVNULL)
    html = os.path.join(out, "%02d.html" % i)
    png = os.path.join(out, "%02d.png" % i)
    subprocess.run([sys.executable, "-I", os.path.join(shots, "ansi2html.py"), html, title,
                    "file:" + os.path.join(out, "%02d.ansi" % i)], check=True)
    subprocess.run([snap, html, png], check=True)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
