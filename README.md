# starship-statusline

A Claude Code status bar rendered by Starship, laid out like the cc-memento
oh-my-posh bar, plus the matching shell prompt. Runs on Deno.

## Use

Try it in one session:

```sh
claude --settings '{"statusLine":{"type":"command","command":"deno run -A /Users/you/Developer/starship-statusline/statusline.mjs","padding":0}}'
```

To keep it, set the same `statusLine` in `~/.claude/settings.json`.

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
