# Changelog

Each release lists what people can see or do. `cc-starship --version` prints the exact build:
`cc-starship 1.3.1 (52 · 1a2b3c4) release · macOS 27.3 arm64` (version, build number, commit).

## 1.3.1 (not released yet: on the owner's machine for a trial)

- The session time pads its minutes: `13h03m`, not `13h3m` (1.3.0 had dropped the space without padding).
  Every reset time (4 formats × 1,440 minutes) and session length up to 48 h checked.

## 1.3.0 (not released yet)

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
some they read as a hole in the bar. Copies that updated to it are offered 1.3.0.

## 1.1.1 (tagged, never released)

Warning chips with powerline arrows (first version).

## 1.1.0 (2026-10-26)

Update in place from a newer download; a daily update check with a status bar marker; GPL-3.0-or-later.

## 1.0.1 (2026-10-24)

No Starship timeout warning in a friend's very first tab.

## 1.0.0 (2026-10-24)

First release: status bar and shell prompt, 15 looks, control panel, add-ons, byte-exact uninstall.
