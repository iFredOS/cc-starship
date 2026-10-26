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
7. Update the installed copies: this Mac, `ssh m1`, `ssh gaming-pc` (copy the exe as
   `cc-starship-new.exe` into `%TEMP%`, run `install --no-starship-update`, delete it).

Test rigs for anything touching install, uninstall or a shell profile: the throwaway Windows
account (`ssh testuser@192.0.2.10`), the Windows 11 ARM VM (`~/VMs/win11-reset.sh`, then
`ssh win11-vm`), a clean macOS (`tart clone ghcr.io/cirruslabs/macos-golden-gate-base:latest …`),
and `scripts/conpty/run.sh` for the panel on Windows.

## Code

- Nerd Font glyphs are written as `\u{...}` escapes; raw glyphs get lost in edits.
- Tests use their own home and temp folder; never leave test data in a real install.
- Processes that must outlive this program are spawned with `detached: true` (Deno ends the
  others when it exits).
