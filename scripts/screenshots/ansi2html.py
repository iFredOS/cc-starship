# ANSI (24-bit SGR) -> one HTML "terminal window" per input; used for README screenshots.
import html, re, sys
import os
FONTS = os.path.expanduser("~/Library/Fonts")
FONT = os.environ.get("SHOT_FONT", f"{FONTS}/JetBrainsMonoNerdFont-Regular.ttf")
FONT_BOLD = os.environ.get("SHOT_FONT_BOLD", f"{FONTS}/JetBrainsMonoNerdFont-Bold.ttf")
BASIC = ["#1d2021","#fb4934","#b8bb26","#fabd2f","#83a598","#d3869b","#8ec07c","#d5c4a1"]
BRIGHT = ["#665c54","#fb4934","#b8bb26","#fabd2f","#83a598","#d3869b","#8ec07c","#fbf1c7"]
FG, BG = "#ebdbb2", "#1d2021"

def convert(text):
    out, fg, bg, bold, dim = [], None, None, False, False
    def span(s):
        if not s: return
        st = []
        if fg: st.append(f"color:{fg}")
        if dim and not fg: st.append("color:#928374")
        if bg: st.append(f"background:{bg}")
        if bold: st.append("font-weight:700")
        out.append(f'<span style="{";".join(st)}">{html.escape(s)}</span>' if st else html.escape(s))
    pos = 0
    for m in re.finditer(r"\x1b\[([0-9;?]*)([A-Za-z])", text):
        span(text[pos:m.start()]); pos = m.end()
        if m.group(2) != "m": continue
        p = [int(x) if x else 0 for x in m.group(1).split(";")] if m.group(1) else [0]
        i = 0
        while i < len(p):
            c = p[i]
            if c == 0: fg = bg = None; bold = dim = False
            elif c == 1: bold = True
            elif c == 2: dim = True
            elif c == 22: bold = dim = False
            elif c in (38, 48) and i + 1 < len(p) and p[i+1] == 2:
                col = "#%02x%02x%02x" % tuple(p[i+2:i+5]); i += 4
                if c == 38: fg = col
                else: bg = col
            elif c in (38, 48) and i + 1 < len(p) and p[i+1] == 5:
                n = p[i+2]; i += 2
                col = (BASIC + BRIGHT)[n] if n < 16 else "#888"
                if c == 38: fg = col
                else: bg = col
            elif c == 39: fg = None
            elif c == 49: bg = None
            elif 30 <= c <= 37: fg = BASIC[c-30]
            elif 90 <= c <= 97: fg = BRIGHT[c-90]
            elif 40 <= c <= 47: bg = BASIC[c-40]
            i += 1
    span(text[pos:])
    return "".join(out)

def page(blocks, title=""):
    body = "".join(
        f'<div class="cap">{html.escape(cap)}</div>' if kind == "cap" else f'<pre>{convert(txt)}</pre>'
        for kind, cap, txt in blocks)
    return f"""<!doctype html><meta charset="utf-8"><style>
@font-face{{font-family:JBM;src:url("file://{FONT}")}}
@font-face{{font-family:JBM;font-weight:700;src:url("file://{FONT_BOLD}")}}
html,body{{margin:0;background:transparent}}
.win{{display:inline-block;margin:0;background:{BG};border-radius:12px;overflow:hidden;border:1px solid #3c3836}}
.bar{{height:34px;display:flex;align-items:center;gap:8px;padding:0 14px;background:#282828;color:#a89984;font:13px -apple-system,sans-serif}}
.dot{{width:12px;height:12px;border-radius:50%}}
.t{{flex:1;text-align:center;margin-right:52px}}
.body{{padding:16px 22px 18px}}
pre{{margin:0;font:15px/1.45 JBM;color:{FG};white-space:pre}}
.cap{{font:600 12px -apple-system,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#a89984;margin:12px 0 6px}}
.cap:first-child{{margin-top:0}}
</style><div class="win" id="win"><div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span class="t">{html.escape(title)}</span></div><div class="body">{body}</div></div>"""

if __name__ == "__main__":
    # args: out.html title  then pairs: cap:"Caption" | file:path.ansi
    out, title, *items = sys.argv[1:]
    blocks = []
    for it in items:
        kind, _, val = it.partition(":")
        blocks.append(("cap", val, "") if kind == "cap" else ("pre", "", open(val, encoding="utf-8").read().rstrip("\n")))
    open(out, "w").write(page(blocks, title))
