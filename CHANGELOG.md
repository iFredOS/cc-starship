# Changelog

Each release lists what people can see or do. `cc-starship --version` prints the exact build:
`cc-starship 1.3.3 (52 · 1a2b3c4) release · macOS 27.3 arm64` (version, build number, commit).

## 1.4.0 (2026-11-25)

- **`cc-starship` works in new terminal tabs**, without its full path: install adds the program's folder to
  PATH in each shell profile it sets up (zsh, bash, PowerShell), in a block of its own that uninstall removes.
  It goes at the end of PATH, so it never hides a command of yours (a Starship you install yourself stays
  first). It is added whatever parts are switched on; updating an existing install adds it too.
- On Windows, this block counts as a reason to let Windows PowerShell run your profile: an account that blocks
  scripts gets `RemoteSigned` (put back on uninstall), as it already did with the shell prompt or memory on.
- cmd.exe and Git Bash don't read these profiles, so they still need the full path; so does bash on a Mac,
  whose tabs read `~/.bash_profile` rather than the `~/.bashrc` the installer sets up.
- Uninstall with 1.4.0 or newer: an older copy doesn't know this block and leaves it in your profiles.
- **Shell memory (zsh): a command typed with a leading space is not yours.** zsh already kept it out of
  history; now a `cd` in it doesn't move the folder new tabs open in either. Agents that type commands into
  terminal tabs (a `cd … && claude` launch, a `while true` watch loop) filled both, so new tabs opened in an
  agent's folder. They start such commands with a space now.

## 1.3.6 (2026-11-25)

Fixes from a code review of 1.3.4 and 1.3.5:

- _Usage for Claude_ no longer passes an idle session's old numbers to Claude. Each redraw re-stamped the
  session's snapshot, so it looked newer than the shared numbers that changed since. A snapshot now records
  when its numbers last changed, and that is what gets compared.
- If saving the shared numbers fails once (a full disk, a lock on Windows), the next draw tries again instead
  of waiting for the numbers to change.

## 1.3.5 (2026-11-25)

- The shell prompt and _Usage for Claude_ no longer jump back to old numbers. Every Claude Code session
  redraws its bar about once a minute with the numbers of its own last request, so a session left idle since
  yesterday kept putting back yesterday's 7-day figure (seen after the Ultra change: 86–96 % while active
  sessions said 6 %). A session now saves the shared numbers only when they changed since its last draw.

## 1.3.4 (2026-11-25)

- The shell prompt, `cc-starship usage` and _Usage for Claude_ follow plans with no 5-hour limit (Ultra,
  formerly Max 20x, since November 2026). Claude Code then sends the 7-day window alone, and the status bar
  saved nothing unless both were there, so they kept showing the last numbers from before the change. A
  missing window is now saved as missing and left out: `✻ 7d 6%`.

## 1.3.3 (2026-11-13)

- Calm chips (below 70%) are easier to read where they had faded the number: on Sunset, Autumn, Tidepool and
  Jewel's 5-hour segment the chip is now a deeper shade of the segment (Sunset: 2.8:1 → 6.5:1), and light
  segments get a lighter chip under their dark text. Dark segments keep the same look, so no chip comes near
  the terminal background. Chosen from three options by a blind panel of three model families (Qwen, Gemma,
  GPT-4o). Tested on all 15 looks.

## 1.3.2 (never released: trial builds, all in 1.3.3)

Fixes from a code review of everything since 1.1.0:

- The shell prompt shows usage again for someone who uses only a second-account profile: the prompt's shell
  rarely has Claude Code's `CLAUDE_CONFIG_DIR`, so it found no file of its own. It now falls back to the most
  recently updated account's file, only when its own is missing (main and a profile: the prompt keeps main's).
  Left as is: a profile-only user upgrading from 1.1 keeps an old `usage` file, which the prompt shows until
  its windows reset (then 0%); deleting it fixes that.
- Other spellings of `~/.claude` count as the main account (`C:/Users/…`, other capitals, `//`, `/./`), and a
  `.claude-<name>` folder outside the home folder gets its own file instead of sharing `usage-<name>`.
- `--version` reports the build even when the binary was renamed.
- Tests: the panel preview's usage file per account.

## 1.3.1 (never released: trial builds, all in 1.3.3)

- The session time pads its minutes: `13h03m`, not `13h3m` (1.3.0 had dropped the space without padding).
  Every reset time (4 formats × 1,440 minutes) and session length up to 48 h checked.

## 1.3.0 (never released: trial builds, all in 1.3.3)

- Every percentage is a chip with powerline arrows at both ends: a calm shade of its segment below 70%, amber
  from 70%, red with ▲ from 90%. Where amber or red would nearly match the segment, the chip is a deep shade
  of the segment with amber or red text. Tested on all 15 looks.
- Shorter times, to make room: `9h04`, `18h`, `6PM`, `2:38AM`, session time `1h32m`; no `·` after a chip, its
  arrow already separates.
- Looks screen: **A** switches the preview to a high-usage sample, to see a look's warning chips.
- Several Claude accounts: each `CLAUDE_CONFIG_DIR` saves its 5-hour and 7-day usage in its own file, so one
  account's bar no longer overwrites another's numbers. The panel's preview reads the right one, and a profile
  named `~/.claude-main` doesn't share the main account's file.
- `--version` prints the build number, commit and system; `status` shows the build. Updating in place still
  recognizes copies that print only a version (1.0 to 1.2).

## 1.2.0 (withdrawn)

Published 2026-11-03 and deleted the same day: its warning chips had not been checked on every look, and on
some they read as a hole in the bar. Copies that updated to it are offered the next release.

## 1.1.1 (tagged, never released)

Warning chips with powerline arrows (first version).

## 1.1.0 (2026-10-26)

Update in place from a newer download; a daily update check with a status bar marker; GPL-3.0-or-later.

## 1.0.1 (2026-10-24)

No Starship timeout warning in a friend's very first tab.

## 1.0.0 (2026-10-24)

First release: status bar and shell prompt, 15 looks, control panel, add-ons, byte-exact uninstall.
