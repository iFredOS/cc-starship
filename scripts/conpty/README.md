# ConPTY harness: drive a Windows TUI from this Mac and see what it draws

`run.sh` copies a program to the gaming PC, runs it inside a Windows pseudo console (ConPTY)
at a size you choose, types a key script into it, and brings back every byte it drew. Then
`vt.py` replays those bytes through a small terminal emulator and prints the screen as plain
text, one frame per key. With `--png` it also renders the frames as images, using
`scripts/screenshots/`.

| File | Runs on | What it does |
|---|---|---|
| `run.sh` | Mac | Stages a fresh `%TEMP%\ccs-conpty-<id>` on the PC, runs the harness over ssh, fetches the results, then calls `vt.py` |
| `harness.ps1` | PC | PowerShell 5.1/7 with embedded C#. Calls `CreatePseudoConsole` and `CreateProcess` (PSEUDOCONSOLE attribute), drains the pipes, runs the key script, puts the child in a Job Object, records `output.raw` and `timeline.tsv` |
| `vt.py` | Mac | Emulates the VT stream and cuts it into frames. Writes `frames/NN.txt` (exact), `NN.ansi` (24-bit SGR) and `index.tsv`. Can also render PNGs |
| `keys/*.keys` | — | Key scripts |
| `NOTES.md` | — | Build log and findings |

## Smoke test

```sh
scripts/conpty/run.sh -s 120x40 -k scripts/conpty/keys/smoke-panel.keys          # summary + last drawn frame
scripts/conpty/run.sh -s 120x40 -k scripts/conpty/keys/smoke-panel.keys --all    # every frame
scripts/conpty/run.sh -s 60x20  -k scripts/conpty/keys/smoke-panel.keys --png all
```

With no `--cmd`, it runs `dist/cc-starship-x86_64-pc-windows-msvc.exe` with no arguments, which opens
the control panel. It does not build anything. Arguments after `--` go to the exe, for example
`run.sh -K 'idle 500' -- preview fusain`.

Results land in `$TMPDIR/ccs-conpty-runs/<id>/`. Change that with `--out DIR`. The folder holds:

```
output.raw  timeline.tsv  result.json  env.json  harness.log  job.json  harness.stdout
frames/01.txt 01.ansi [01.png] … index.tsv
```

Re-read a run without the PC: `python3 scripts/conpty/vt.py <run dir> [--all|--frame N] [--png N]`.

## Key scripts

There is one step per line. `#` starts a comment, either at the start of a line or after whitespace.

| Step | Meaning |
|---|---|
| `wait 800` | Sleep 800 ms. |
| `key Down [count] [gapMs]` | Send a named key, `count` times, `gapMs` apart (default 150). Names: `Up Down Left Right Home End PgUp PgDn Insert Delete Tab ShiftTab Enter Esc Space Backspace CtrlC CtrlD F1`–`F4`, or any single character (`key q`). |
| `send <text>` | Send raw text. Escapes: `\e` `\x1b` `\xHH` `\u{1F600}` `\uHHHH` `\r` `\n` `\t` `\s` (space) `\cC` (Ctrl+C) `\\`. Example: `send \e[1;5C`. |
| `waittext <text> [timeoutMs]` | Wait until `<text>` appears in the ANSI-stripped output received since the last key (default 10 s). On timeout, log it and carry on. |
| `idle <quietMs> [maxMs]` | Wait until no output has arrived for `quietMs` (cap `maxMs`, default 10 s). This is the most reliable "screen settled". |
| `mark <label>` | Snapshot a frame here, with a label. |
| `resize <cols> <rows>` | `ResizePseudoConsole`. vt.py follows the resize. |
| `waitexit [ms]` | Wait for the child to exit. |

You get a frame before every key sent, at every `mark`, when the child exits, and after the console
closes. Identical neighbouring frames are merged.

Inline: `-K 'waittext Fusain 30000 ; idle 500 ; key E ; idle 400 ; key q'` (steps separated by ` ; `).

Smoke script (`keys/smoke-panel.keys`): `waittext Fusain` → `idle` → 3× `Down` → `Tab` →
`waittext Components` → `q`.

## Safety (built in)

- Each run has its own folder, `%TEMP%\ccs-conpty-<yyyymmdd-hhmmss>-<hex>`. These are never deleted
  unless you pass `--cleanup`, and then only that exact folder is removed. Exe copies are kept in
  `%TEMP%\ccs-conpty-cache\<sha256-prefix>.exe` and copied into each run folder from there.
- Every run sets the following, all pointing inside the run folder:
  - `CC_STARSHIP_HOME`
  - `CC_STARSHIP_PROFILES` (two empty fake profiles)
  - `CC_STARSHIP_TERMINALS` (a fake WT `settings.json`)
  - `STARSHIP_CONFIG`
  - `CLAUDE_CONFIG_DIR`

  It also sets `HTTPS_PROXY` and `HTTP_PROXY` to `http://127.0.0.1:9`. `run.sh` refuses `-e` overrides
  of these variables. The harness refuses to start if any of them is empty or points outside the run
  folder. `run.sh` checks `env.json` again afterwards.
- Real `USERPROFILE` and `LOCALAPPDATA` are still visible. The panel *reads* the real font folders,
  PATH and the starship version, so the Components screen reflects the PC. Navigation writes nothing,
  but Enter (install), font actions and Starship update/remove are real actions. Don't script them
  unless you have also sandboxed `USERPROFILE`/`LOCALAPPDATA` with `-e`.
- The child is created suspended, put in a Job Object with `KILL_ON_JOB_CLOSE`, then resumed. A
  timeout terminates that job only: the child and what it spawned. Nothing else is touched; there
  are no kills by name. A timed-out child exits with 0xC0DE0124, and `run.sh` exits 124.
- The harness runs as `powershell -NoProfile`, so the real `$PROFILE` is not loaded by the harness.
  The ssh login shell itself may still read it, but nothing writes to it.

## Gotchas

- **ConPTY re-renders.** conhost does not forward the app's own bytes. It draws into its buffer and
  emits the differences: absolute moves, `ESC[nX`/`ESC[nC` for runs of blanks, a full repaint after
  each app clear. The panel's `ESC[H ESC[2J` never shows up, so frames have to come from emulation
  plus the key timeline, not from splitting on clears. `?1049h/l` *is* forwarded on this build
  (26200).
- **STARTF_USESTDHANDLES is required under ssh.** Without it the child inherits sshd's pipes, and
  its output goes to the ssh session instead of the pseudo console. The harness sets it
  (`useStdHandles: true`).
- **Nerd Font glyphs are 1 cell in conhost**, as are `● ◐ ✻ … ─ │ ▸ ▲ ⏎`. Only emoji and CJK are 2
  cells. This was measured with `[Console]::CursorLeft`. Many viewers, including an agent's tool
  output, draw these glyphs zero-width, so correct rows *look* short. The printed frames therefore show
  them as `¤`. `--exact` prints them as-is, and `frames/*.txt` always keep them.
- **PNGs are not cell-exact.** The HTML renderer lets wide-looking Nerd glyphs push the rest of the
  row, so right borders can wobble. Use the `.txt` frames to judge layout.
- The first launch of a freshly copied exe is slow. CreateProcess alone took about 1.2 s, probably a
  Defender scan. Use `waittext`/`idle` rather than fixed waits.
- The exe upload is about 30 s over the LAN the first time. After that it comes from the cache in
  about 6 s. `--no-cache` uploads straight into the run folder.
- ConPTY can send `ESC[6n` or DA1 requests. The harness answers them automatically and logs them as
  `reply(...)`.
- Escape timing: `key Esc` sends a lone `\e`, which conhost has to disambiguate from a sequence
  start. Leave an `idle` after it.
- ssh lands in Windows PowerShell 5.1, so the C# in `harness.ps1` is kept to C# 5. `--pwsh` runs the
  harness under PowerShell 7 instead.
- The ssh control socket lives in `/tmp/ccs-conpty-<id>.sock`, because macOS limits unix socket
  paths to 104 bytes.
