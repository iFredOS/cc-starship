#!/bin/zsh
# Renders the bar from sample payloads and checks the visible text.
zmodload zsh/datetime
dir=${0:A:h}
tmp=$(mktemp -d)
trap 'rm -rf $tmp' EXIT

# Account email comes from $CLAUDE_CONFIG_DIR/.claude.json; use a fixture.
print -r -- '{"oauthAccount":{"emailAddress":"you@example.com"}}' > $tmp/.claude.json
export CLAUDE_CONFIG_DIR=$tmp
# Usage numbers shared with the shell prompt go here instead of ~/.cache.
export STATUSLINE_CACHE_DIR=$tmp/cache
export LC_ALL=en_US.UTF-8
unset COLUMNS

raw()   { deno run -A "${proj:-$dir}/statusline.mjs" }
plain() { raw | perl -pe 's/\e\[[0-9;]*m//g' }
payload() { print -r -- "{\"model\":{\"display_name\":\"Opus 5.5\"},\"workspace\":{\"current_dir\":\"${2:-/tmp}\"}$1}" }
fail=0
expect() { [[ $out == *"$1"* ]] || { print -r -- "FAIL ($2): missing '$1'"; fail=1 } }
reject() { [[ $out != *"$1"* ]] || { print -r -- "FAIL ($2): unexpected '$1'"; fail=1 } }

# Full payload: every segment present.
out=$(plain < "$dir/fixture.json")
print -r -- "$out"
for s in "✻ Opus 5.5" "◐ Medium" $' v2.1.290' $' you@example.com' \
         $' ~/projects/my-app' $' ─' $' +156/−23 ·  2h 21m' \
         $' CTX 8% / 15.5K ($1.23)' $' 5h 42%' $' 7d 13%'; do
  expect "$s" full
done
[[ $(print -r -- "$out" | wc -l | tr -d ' ') == 3 ]] || { print "FAIL (full): expected 3 lines"; fail=1 }
# Nerd Font glyphs are invisible in most viewers; check every line has a
# rounded start cap (U+E0B6), an arrow (U+E0B0) and a rounded end cap (U+E0B4).
for line in "${(@f)out}"; do
  [[ $line == $''*$''*$''* ]] || { print -r -- "FAIL (glyphs): $line"; fail=1 }
done

# Minimal payload: no effort, version, rate limits or cost yet.
out=$(payload | CLAUDE_CONFIG_DIR=$tmp/none plain)
print -r -- "$out"
expect "✻ Opus 5.5" minimal
expect "CTX 0% / 0 (\$0.00)" minimal
for s in "5h" "◐" "undefined" "NaN" $''; do reject "$s" minimal; done
for line in "${(@f)out}"; do
  [[ $line == $''*$''* ]] || { print -r -- "FAIL (minimal caps): $line"; fail=1 }
done

# Model names lose the "(1M context)" suffix, as in the oh-my-posh bar.
out=$(print -r -- '{"model":{"display_name":"Opus 4.7 (1M context)"}}' | plain)
expect "✻ Opus 4.7 " model; reject "context" model

# Resets within 24 h show only the time; later ones are prefixed with the weekday.
soon=$(( EPOCHSECONDS + 2 * 3600 )); later=$(( EPOCHSECONDS + 3 * 86400 ))
out=$(payload ",\"rate_limits\":{\"five_hour\":{\"used_percentage\":1,\"resets_at\":$soon},\"seven_day\":{\"used_percentage\":23,\"resets_at\":$later}}" | plain)
print -r -- "$out"
expect "5h 1% · $(date -r $soon +%H:%M)" resets
expect "7d 23% · $(date -r $later '+%a %H:%M')" resets

# A spent 5-hour window reads "Extra", as in the oh-my-posh bar.
out=$(payload ',"rate_limits":{"five_hour":{"used_percentage":100},"seven_day":{"used_percentage":40}}' | plain)
expect $' 5h  Extra' extra

# Percentages turn amber at 70% and red at 90%.
out=$(payload ',"context_window":{"used_percentage":95},"rate_limits":{"five_hour":{"used_percentage":75},"seven_day":{"used_percentage":10}}' | raw)
expect $'\e[38;2;251;73;52m95%' colors
expect $'\e[38;2;250;189;47m75%' colors
reject $'\e[38;2;250;189;47m10%' colors

# Branch with dirty marker, from a throwaway repo.
repo=$tmp/repo
git -c init.defaultBranch=main init -q $repo
print hi > $repo/f; git -C $repo add f; git -C $repo -c user.name=t -c user.email=t@t commit -qm init
print bye > $repo/f
out=$(payload "" $repo | plain)
expect $' main *' git

# Prompt cache: minutes left while warm (amber from 5 min), "cold" once expired.
cache() { payload ",\"prompt_cache\":{\"caching_observed\":true,$1}" | ${2:-plain} }
out=$(cache "\"warm\":true,\"expires_at\":$(( EPOCHSECONDS + 42 * 60 + 10 ))"); expect $' 42m' cache-warm
out=$(cache "\"warm\":true,\"expires_at\":$(( EPOCHSECONDS + 4 * 60 + 10 ))" raw); expect $'\e[38;2;250;189;47m4m' cache-soon
out=$(cache '"warm":false,"expires_at":null' raw); expect $' \e[38;2;250;189;47mcold' cache-cold
out=$(payload | plain); reject $'' cache-absent; reject $'' cache-absent
out=$(payload ',"prompt_cache":{"caching_observed":false,"warm":false}' | plain); reject $'' cache-off

# Worktrees: show the worktree name, not Claude Code's "worktree-<name>" branch.
wt='"git_worktree":"feature-xyz"},"worktree":{"name":"feature-xyz","branch":"worktree-feature-xyz"'
out=$(print -r -- "{\"model\":{\"display_name\":\"Opus 5.5\"},\"workspace\":{\"current_dir\":\"/tmp\",$wt}}" | plain)
expect $'\U000f0645 feature-xyz' worktree; reject "worktree-feature-xyz" worktree
long=add-a-very-long-worktree-name-for-testing
out=$(print -r -- "{\"model\":{\"display_name\":\"Opus 5.5\"},\"workspace\":{\"current_dir\":\"/tmp\",\"git_worktree\":\"$long\"}}" | plain)
expect "…" worktree-long; reject "$long" worktree-long

# Narrow terminals: every line fits in $COLUMNS; the essentials stay.
fits() {
  local w=$1 line
  out=$(COLUMNS=$w plain < $dir/fixture.json)
  for line in "${(@f)out}"; do
    (( ${#line} <= w )) || { print -r -- "FAIL (width $w): ${#line} cols: $line"; fail=1 }
  done
}
fits 60; expect "✻ Opus 5.5" narrow; expect "CTX 8%" narrow
fits 45; expect "✻ Opus 5.5" narrower; expect "CTX 8%" narrower; reject "you@example.com" narrower
out=$(COLUMNS=200 plain < $dir/fixture.json); expect "you@example.com" wide

# The bar saves 5h/7d usage for the shell prompt, which shows it and zeroes a
# window once its reset time has passed.
shell_usage() { STARSHIP_CONFIG=$dir/shell.toml STARSHIP_SHELL= starship prompt | perl -pe 's/\e\[[0-9;]*m//g' }
rm -rf $STATUSLINE_CACHE_DIR
out=$(shell_usage); reject "5h" shell-no-usage; reject "✻" shell-no-usage
payload ",\"rate_limits\":{\"five_hour\":{\"used_percentage\":42,\"resets_at\":$(( EPOCHSECONDS + 3600 ))},\"seven_day\":{\"used_percentage\":23,\"resets_at\":$(( EPOCHSECONDS + 86400 ))}}" | plain >/dev/null
out=$(shell_usage); expect "✻ 5h 42% · 7d 23%" shell-usage
payload ",\"rate_limits\":{\"five_hour\":{\"used_percentage\":42,\"resets_at\":$(( EPOCHSECONDS - 60 ))},\"seven_day\":{\"used_percentage\":23,\"resets_at\":$(( EPOCHSECONDS + 86400 ))}}" | plain >/dev/null
out=$(shell_usage); expect "✻ 5h 0% · 7d 23%" shell-usage-reset

# Theme switch, on a throwaway copy of the project so the real files stay put.
proj=$tmp/proj
cp -R $dir $proj
# Starship merges background and text into one escape, so match the values only.
orange='48;2;214;93;14'; darkest='48;2;40;40;40'; salmon=$'\e[38;2;215;135;112m'
shell_prompt() { STARSHIP_CONFIG=$proj/shell.toml STARSHIP_SHELL= starship prompt }

$proj/theme rainbow >/dev/null
[[ $($proj/theme) == rainbow ]] || { print "FAIL (theme): current theme is not rainbow"; fail=1 }
out=$(raw < $dir/fixture.json); expect "$orange" rainbow-bar; reject "$salmon" rainbow-bar
out=$(shell_prompt); expect "$orange" rainbow-shell

$proj/theme gray >/dev/null
[[ $($proj/theme) == gray ]] || { print "FAIL (theme): current theme is not gray"; fail=1 }
out=$(raw < $dir/fixture.json); expect "$darkest" gray-bar; expect "$salmon" gray-bar; reject "$orange" gray-bar
out=$(shell_prompt); expect "$darkest" gray-shell; reject "$orange" gray-shell

$proj/theme purple >/dev/null 2>&1 && { print "FAIL (theme): accepted an unknown theme"; fail=1 }
[[ $($proj/theme) == gray ]] || { print "FAIL (theme): unknown theme changed the setting"; fail=1 }
unset proj

(( fail )) && exit 1 || print "all checks passed"
