#!/bin/bash
# Regenerates docs/images/*.png from the real program (macOS; needs a build in dist/,
# starship, Swift, and JetBrainsMono Nerd Font in ~/Library/Fonts).
# Everything runs in a throwaway demo home, offline: no real files, account or network.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../.." && pwd)
OUT="$REPO/docs/images"; B="$REPO/dist/cc-starship-$(uname -m | sed 's/arm64/aarch64/')-apple-darwin"
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
REAL_USER=$(id -un)

# A demo home with a project on a feature branch.
mkdir -p "$W/home/projects/my-app" "$W/home/.claude" "$W/home/.config" "$W/home/Library/Fonts"
ln -s ~/Library/Fonts/JetBrainsMonoNerdFont-*.ttf "$W/home/Library/Fonts/"
( cd "$W/home/projects/my-app" && git init -q -b main && printf '{ "name": "my-app" }\n' > package.json &&
  echo 'export const app = 1;' > index.ts && git add -A &&
  git -c user.name=demo -c user.email=demo@example.com commit -qm init &&
  git checkout -qb feature/login-form && echo '// login' >> index.ts )
echo '{"oauthAccount":{"emailAddress":"you@example.com"}}' > "$W/home/.claude.json"
export HOME="$W/home" CC_STARSHIP_HOME="$W/home/.local/share/cc-starship" CC_STARSHIP_PROFILES="$W/home/.zshrc"
export CC_STARSHIP_TERMINALS="" CLAUDE_CONFIG_DIR="$W/home/.claude" STARSHIP_CONFIG="$W/home/.config/starship.toml"
export HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 TERM=xterm-256color COLORTERM=truecolor
unset CLAUDECODE
cd "$W/home/projects/my-app"
"$B" install --no-starship-update >/dev/null
anon() { sed "s/$REAL_USER/you/g"; }

for p in fusain rainbow nord-v1 tokyo-night synthwave ember; do "$B" preview $p | anon > "$W/preview-$p.ansi"; done
head -3 "$W/preview-fusain.ansi" > "$W/bar.ansi"; tail -1 "$W/preview-fusain.ansi" > "$W/prompt.ansi"
deno run -A "$HERE/render.ts" "$W" "$PWD" >/dev/null

# The real control panel in a pseudo-terminal: Looks (explanations are on by default), then Components.
(sleep 5; printf '\t'; sleep 2; printf 'q') |
  script -q "$W/tui.raw" sh -c "stty cols 112 rows 46; exec '$B'" >/dev/null 2>&1 || true
python3 -I - "$W" <<'PY'
import re, sys
w = sys.argv[1]
raw = open(f"{w}/tui.raw", "rb").read().decode("utf-8", "replace").split("\x1b[?1049l")[0]  # until the panel exits
frames = [re.sub(r"\x1b\[\?[0-9;]*[hl]", "", f).replace("\r\n", "\n") for f in raw.split("\x1b[H\x1b[2J") if f.strip()]
plain = lambda f: re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", f)
looks = next((f for f in frames if "hide explanations" in plain(f)), None)
comps = next((f for f in frames if "╭─ Components" in plain(f)), None)
if not (looks and comps):
    sys.exit(f"panel capture: {len(frames)} frames, looks={bool(looks)} components={bool(comps)}; "
             f"last frame ends: {plain(frames[-1])[-400:] if frames else raw[-400:]!r}")
open(f"{w}/panel-looks.ansi", "w").write(looks); open(f"{w}/panel-components.ansi", "w").write(comps)
PY
for f in panel-looks panel-components; do anon < "$W/$f.ansi" > "$W/$f.clean.ansi"; done

swiftc -O "$HERE/snap.swift" -o "$W/snap" 2>/dev/null
snap() { python3 -I "$HERE/ansi2html.py" "$W/$1.html" "${@:2}" && "$W/snap" "$W/$1.html" "$OUT/$1.png"; }
mkdir -p "$OUT"
snap hero "~/projects/my-app" "cap:Claude Code status bar" "file:$W/bar.ansi" "cap:Shell prompt" "file:$W/prompt.ansi"
snap warnings "Claude Code" "cap:Context at 92%, 5-hour limit at 74%" "file:$W/warn.ansi"
snap narrow "Claude Code · narrow window" "file:$W/narrow.ansi"
args=()
for p in fusain:Fusain rainbow:Rainbow nord-v1:"Nord v1" tokyo-night:"Tokyo Night" synthwave:Synthwave ember:Ember; do
  id=${p%%:*}; { head -3 "$W/preview-$id.ansi"; echo; tail -1 "$W/preview-$id.ansi"; } > "$W/gap-$id.ansi"
  args+=("cap:${p#*:}" "file:$W/gap-$id.ansi")
done
snap presets "6 of the 15 looks · status bar, then shell prompt" "${args[@]}"
snap panel-looks "cc-starship" "file:$W/panel-looks.clean.ansi"
snap panel-components "cc-starship" "file:$W/panel-components.clean.ansi"
