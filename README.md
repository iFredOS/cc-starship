# starship-statusline

A Claude Code status bar rendered by Starship, laid out like the cc-memento
oh-my-posh bar, plus the matching shell prompt. Runs on Deno.

## Use

Try it in one session:

```sh
claude --settings '{"statusLine":{"type":"command","command":"deno run -A /Users/you/Developer/starship-statusline/statusline.mjs","padding":0,"refreshInterval":60}}'
```

To keep it, set the same `statusLine` in `~/.claude/settings.json`. `refreshInterval`
keeps the prompt cache countdown ticking while the session is idle.

## What it shows

| Line | Segments |
|---|---|
| 1 | model, effort, Claude Code version, account |
| 2 | directory, branch (or worktree name), lines changed and session time |
| 3 | context and cost, prompt cache timer, 5h and 7d rate limits with reset times |

Percentages turn amber at 70% and red at 90%. The cache timer counts down the
minutes until the prompt cache goes cold (amber in the last 5) and then reads
`cold`: the next message re-sends the whole context at full price.

On narrow terminals each line drops its least useful parts until it fits
`$COLUMNS`: account, version and effort; session time, then the diff; reset
times, 7d, the cache timer and 5h. Model, directory and context always stay.

The shell prompt shows the same 5h/7d usage, read from
`~/.cache/starship-statusline/usage`, which the status bar rewrites on each refresh.

## Themes

```sh
./theme            # print the current theme
./theme rainbow    # gruvbox-rainbow colors
./theme gray       # the oh-my-posh bar's grays
```

One switch changes both the status bar (`statusline.toml`) and the shell prompt
(`shell.toml`, symlinked from `~/.config/starship.toml`). New shell tabs and the
next status bar refresh pick it up.

## Files

| File | What it is |
|---|---|
| `statusline.mjs` | Reads Claude Code's JSON on stdin, sets `CC_*` env vars, runs `starship prompt` |
| `statusline.toml` | Status bar layout and the two palettes |
| `shell.toml` | Shell prompt (gruvbox-rainbow preset, clock replaced by duration and exit code) |
| `theme` | Switches the palette in both TOML files |
| `test.sh` | Renders sample payloads and checks text, glyphs, colors and theme switching |
| `bench.py` | Times this bar against the oh-my-posh one; results go to `bench-results/` |

Nerd Font glyphs are invisible in most editors and get lost in edits; run
`./test.sh` after changing a TOML file.
