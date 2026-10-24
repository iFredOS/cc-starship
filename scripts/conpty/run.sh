#!/bin/bash
# Drive a Windows console (TUI) program on the gaming PC through ConPTY and read back what it drew.
#
#   scripts/conpty/run.sh [options] [-- program args...]
#
# Copies harness.ps1 + the program to a fresh %TEMP%\ccs-conpty-<id> folder on the PC, runs it in
# a pseudo console with the key script, copies output.raw/timeline.tsv/result.json back, replays
# them through vt.py and prints the last frame as plain text. See README.md.
#
# Options:
#   -s, --size COLSxROWS   pseudo console size (default 120x40)
#   -k, --keys FILE        key script file ('-' = stdin)
#   -K, --key-script TEXT  inline key script; steps separated by newlines or " ; "
#   -t, --timeout SEC      overall timeout; only the child's job is killed after it (default 60)
#   -e, --env NAME=VALUE   extra environment variable for the child (repeatable; {run} = remote folder)
#       --exe PATH         local .exe to upload and run (default: dist/cc-starship-x86_64-pc-windows-msvc.exe)
#       --cmd CMDLINE      run this command line on the PC instead (nothing uploaded but the harness)
#       --all              print every frame, not just the last
#       --frame N          print frame N
#       --png N|last|all   also render PNG(s) of frames with scripts/screenshots (ansi2html + snap)
#       --out DIR          local folder for the results (default: $TMPDIR/ccs-conpty-runs/<id>)
#       --host HOST        ssh host (default gaming-pc)
#       --pwsh             run the harness under PowerShell 7 instead of Windows PowerShell 5.1
#       --cleanup          delete this run's remote folder after copying results back (default: keep)
#       --no-cache         upload the exe straight into the run folder (default: reuse a copy kept,
#                          by SHA-256, in %TEMP%\ccs-conpty-cache on the PC; ~30 s saved per run)
#       --exact            print Nerd Font glyphs as-is (default shows them as ¤ to keep columns readable)
#
# Every run sets, inside the run folder: CC_STARSHIP_HOME, CC_STARSHIP_PROFILES (two fake
# profiles), CC_STARSHIP_TERMINALS (a fake WT settings.json), STARSHIP_CONFIG, CLAUDE_CONFIG_DIR,
# plus HTTPS_PROXY/HTTP_PROXY=http://127.0.0.1:9. The harness refuses to start if any of them is
# missing or points outside the run folder, and this script checks env.json again afterwards.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../.." && pwd)

HOST=gaming-pc SIZE=120x40 TIMEOUT=60 KEYS_FILE="" KEYS_TEXT="" CMD="" OUT="" PNG="" SHOW=() CLEANUP=0 CACHE=1
PS_EXE=powershell
EXE="$REPO/dist/cc-starship-x86_64-pc-windows-msvc.exe"
EXTRA_ENV=() ARGS=()
die() { echo "run.sh: $*" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    -s|--size) SIZE=$2; shift 2 ;;
    -k|--keys) KEYS_FILE=$2; shift 2 ;;
    -K|--key-script) KEYS_TEXT=$2; shift 2 ;;
    -t|--timeout) TIMEOUT=$2; shift 2 ;;
    -e|--env) EXTRA_ENV+=("$2"); shift 2 ;;
    --exe) EXE=$2; shift 2 ;;
    --cmd) CMD=$2; shift 2 ;;
    --all) SHOW+=(--all); shift ;;
    --frame) SHOW+=(--frame "$2"); shift 2 ;;
    --png) PNG=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --host) HOST=$2; shift 2 ;;
    --pwsh) PS_EXE="& 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'"; shift ;;
    --cleanup) CLEANUP=1; shift ;;
    --no-cache) CACHE=0; shift ;;
    --exact) SHOW+=(--exact); shift ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    --) shift; ARGS=("$@"); break ;;
    *) die "unknown option $1 (try --help)" ;;
  esac
done
[[ $SIZE =~ ^([0-9]+)x([0-9]+)$ ]] || die "--size must look like 120x40"
COLS=${BASH_REMATCH[1]} ROWS=${BASH_REMATCH[2]}
if [ -n "$KEYS_FILE" ]; then
  if [ "$KEYS_FILE" = - ]; then KEYS=$(cat); else KEYS=$(cat "$KEYS_FILE"); fi
else
  KEYS=${KEYS_TEXT// ; /$'\n'}
fi
[ -n "$CMD" ] || [ -f "$EXE" ] || die "no such exe: $EXE"

ID="$(date +%Y%m%d-%H%M%S)-$(openssl rand -hex 3)"
NAME="ccs-conpty-$ID"
OUT=${OUT:-"${TMPDIR:-/tmp}/ccs-conpty-runs/$ID"}
mkdir -p "$OUT"
# One shared ssh connection for the whole run (unix socket paths max out at 104 bytes: keep it short).
CTL="/tmp/ccs-conpty-$ID.sock"
SSH=(ssh -o BatchMode=yes -o ControlMaster=auto -o "ControlPath=$CTL" -o ControlPersist=120)
SCP=(scp -q -o BatchMode=yes -o ControlMaster=auto -o "ControlPath=$CTL" -o ControlPersist=120)
trap '"${SSH[@]}" -O exit "$HOST" >/dev/null 2>&1 || true' EXIT

RTEMP=$("${SSH[@]}" "$HOST" 'Write-Output $env:TEMP' | tr -d '\r')
[[ $RTEMP =~ ^[A-Za-z]:\\ ]] || die "could not read %TEMP% on $HOST (got '$RTEMP'); is the ssh shell PowerShell?"
RDIR="$RTEMP\\$NAME"            # Windows form, for PowerShell
RDIR_SCP="${RDIR//\\//}"        # forward slashes, for scp

# ── stage the run folder: harness, job, fake profiles and config dirs ──────────
STAGE="$OUT/stage/$NAME"
mkdir -p "$STAGE/work" "$STAGE/sandbox/cc-starship" "$STAGE/sandbox/claude" "$STAGE/sandbox/config" \
  "$STAGE/sandbox/profiles/WindowsPowerShell" "$STAGE/sandbox/profiles/PowerShell" "$STAGE/sandbox/terminals"
: > "$STAGE/sandbox/profiles/WindowsPowerShell/Microsoft.PowerShell_profile.ps1"
: > "$STAGE/sandbox/profiles/PowerShell/Microsoft.PowerShell_profile.ps1"
echo '{ "profiles": { "defaults": {}, "list": [] } }' > "$STAGE/sandbox/terminals/settings.json"
cp "$HERE/harness.ps1" "$STAGE/"
printf '%s\n' "$KEYS" > "$STAGE/keys.txt"
USE_EXE=0
if [ -z "$CMD" ]; then
  USE_EXE=1
  CMD="\"{run}\\$(basename "$EXE")\""
  for a in ${ARGS[@]+"${ARGS[@]}"}; do
    if [[ $a =~ [[:space:]\"] ]]; then CMD+=" \"${a//\"/\\\"}\""; else CMD+=" $a"; fi
  done
fi
python3 -I - "$STAGE/job.json" "$CMD" "$COLS" "$ROWS" "$TIMEOUT" ${EXTRA_ENV[@]+"${EXTRA_ENV[@]}"} <<'PY'
import json, sys
out, cmd, cols, rows, timeout, *extra = sys.argv[1:]
S = "{run}\\sandbox\\"
env = {
    "CC_STARSHIP_HOME": S + "cc-starship",
    "CC_STARSHIP_PROFILES": S + "profiles\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1;"
                            + S + "profiles\\PowerShell\\Microsoft.PowerShell_profile.ps1",
    "CC_STARSHIP_TERMINALS": S + "terminals\\settings.json",
    "STARSHIP_CONFIG": S + "config\\starship.toml",
    "CLAUDE_CONFIG_DIR": S + "claude",
    "HTTPS_PROXY": "http://127.0.0.1:9",
    "HTTP_PROXY": "http://127.0.0.1:9",
}
required = [k for k in env if not k.endswith("_PROXY")]
for kv in extra:
    k, _, v = kv.partition("=")
    if k in required:
        sys.exit(f"run.sh: refusing to override the sandbox variable {k}")
    env[k] = v
json.dump({"commandLine": cmd, "cwd": "{run}\\work", "cols": int(cols), "rows": int(rows),
           "timeoutMs": int(float(timeout) * 1000), "env": env, "requireUnderRun": required,
           "keysFile": "{run}\\keys.txt"}, open(out, "w"), indent=2)
PY

echo "▸ run $NAME on $HOST  (${COLS}x${ROWS}, timeout ${TIMEOUT}s)" >&2
echo "  remote: $RDIR" >&2
echo "  local:  $OUT" >&2
T0=$(date +%s)
"${SCP[@]}" -r "$STAGE" "$HOST:${RTEMP//\\//}/"
if [ "$USE_EXE" = 1 ]; then
  BASE=$(basename "$EXE")
  if [ "$CACHE" = 1 ]; then
    # The exe is ~77 MB (~30 s over the LAN): keep one copy per content hash in
    # %TEMP%\ccs-conpty-cache and copy it into the fresh run folder from there.
    SUM=$(shasum -a 256 "$EXE" | cut -d' ' -f1)
    CDIR="$RTEMP\\ccs-conpty-cache"; CFILE="$CDIR\\${SUM:0:16}.exe"
    HIT=$("${SSH[@]}" "$HOST" "if (Test-Path -LiteralPath '$CFILE') { (Get-FileHash -LiteralPath '$CFILE' -Algorithm SHA256).Hash } else { New-Item -ItemType Directory -Force -Path '$CDIR' | Out-Null; 'miss' }" | tr -d '\r')
    if [ "$(echo "$HIT" | tr 'A-F' 'a-f')" != "$SUM" ]; then
      echo "  uploading $BASE to the cache (${SUM:0:16})…" >&2
      "${SCP[@]}" -C "$EXE" "$HOST:${CFILE//\\//}.part"
      "${SSH[@]}" "$HOST" "Move-Item -Force -LiteralPath '$CFILE.part' -Destination '$CFILE'"
    else
      echo "  $BASE found in the PC cache (${SUM:0:16})" >&2
    fi
    "${SSH[@]}" "$HOST" "Copy-Item -LiteralPath '$CFILE' -Destination '$RDIR\\$BASE'"
  else
    "${SCP[@]}" -C "$EXE" "$HOST:$RDIR_SCP/"
  fi
fi
echo "  staged in $(( $(date +%s) - T0 ))s" >&2

set +e
"${SSH[@]}" "$HOST" "$PS_EXE -NoProfile -NonInteractive -ExecutionPolicy Bypass -File '$RDIR\\harness.ps1' -Job '$RDIR\\job.json'" \
  > "$OUT/harness.stdout" 2>&1
HARNESS_RC=$?
set -e
for f in output.raw timeline.tsv result.json env.json harness.log job.json; do
  "${SCP[@]}" "$HOST:$RDIR_SCP/$f" "$OUT/" 2>/dev/null || echo "  (no $f came back)" >&2
done
if [ ! -f "$OUT/result.json" ]; then
  echo "run.sh: the harness did not finish (rc $HARNESS_RC). Its output:" >&2
  cat "$OUT/harness.stdout" >&2
  exit 3
fi

# Belt and braces: the child really saw sandboxed paths.
python3 -I - "$OUT/env.json" "$RDIR" <<'PY'
import json, sys
env = json.load(open(sys.argv[1], encoding="utf-8-sig"))
root = sys.argv[2].lower().rstrip("\\") + "\\"
bad = []
for k in ("CC_STARSHIP_HOME", "CC_STARSHIP_PROFILES", "CC_STARSHIP_TERMINALS", "STARSHIP_CONFIG", "CLAUDE_CONFIG_DIR"):
    parts = [p for p in (env.get(k) or "").split(";") if p]
    if not parts or any(not p.lower().startswith(root) for p in parts):
        bad.append(f"{k}={env.get(k)!r}")
if env.get("HTTPS_PROXY") != "http://127.0.0.1:9":
    bad.append(f"HTTPS_PROXY={env.get('HTTPS_PROXY')!r}")
if bad:
    sys.exit("run.sh: SANDBOX CHECK FAILED: " + ", ".join(bad))
PY

if [ "$CLEANUP" = 1 ]; then
  # Only the folder this run created, by exact name.
  "${SSH[@]}" "$HOST" "if ('$NAME' -like 'ccs-conpty-*') { Remove-Item -LiteralPath '$RDIR' -Recurse -Force }"
  echo "  removed $RDIR" >&2
fi
rm -rf "$OUT/stage"

python3 -I "$HERE/vt.py" "$OUT" ${SHOW[@]+"${SHOW[@]}"} ${PNG:+--png "$PNG"}
python3 -I -c 'import json,sys; sys.exit(124 if json.load(open(sys.argv[1], encoding="utf-8-sig")).get("timedOut") else 0)' "$OUT/result.json"
