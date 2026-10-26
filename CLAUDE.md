# cc-starship: working notes

## Docs stay current, without being asked

Any change people can see or do (a command, an option, a panel row, the status bar, install or
uninstall behavior) updates the README in the same commit:

- `README.md`: the section describing it, the command list, the "What it changes" table,
  Troubleshooting when testing turned up a trap.
- `docs/images/`: run `scripts/screenshots/make.sh` (needs `deno task build` first) when the
  panel or the bar looks different, then look at the PNGs before committing.
- `tests/docs_test.ts` catches drift between the help text and the README (commands, choices,
  number of looks, images). It runs with `deno task test`; never weaken it to make it pass.

## Release checklist

1. `VERSION` in `src/app.ts` (semver: fixes → patch, features → minor).
2. `deno fmt`, `deno lint`, `deno task test` (all green), docs per above.
3. `deno task build`; check `./dist/cc-starship-aarch64-apple-darwin --version`.
4. `cd dist && shasum -a 256 cc-starship-* > SHA256SUMS.txt` (the three binaries only).
5. Commit, `git tag -a vX.Y.Z`, push the tag, `gh release create vX.Y.Z --latest` with the
   binaries and SHA256SUMS.txt. Notes: what's new, the download table, what was tested, known limits.
6. Download one asset back with `gh release download` and check it with `shasum -c`.
7. Update your own installed copies (on Windows, copy the new exe under a `cc-starship-…` name
   and run `install --no-starship-update`; the running program can't replace itself by name).

Anything touching install, uninstall or a shell profile gets tested on a clean machine first: a
fresh user account or VM on each OS (a clean macOS is one `tart clone` away), with every file of
the account compared before and after. `scripts/conpty/run.sh` drives the panel on a Windows PC
over SSH.

## Code

- Nerd Font glyphs are written as `\u{...}` escapes; raw glyphs get lost in edits.
- Tests use their own home and temp folder; never leave test data in a real install.
- Processes that must outlive this program are spawned with `detached: true` (Deno ends the
  others when it exits).
