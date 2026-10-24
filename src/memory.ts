// Shell memory: new tabs open in the last folder a person cd'd into, and history
// keeps one copy of each command (the newest). Shells run by agents (CLAUDECODE
// set) neither move the remembered folder nor get moved by it.

export type ShellKind = "zsh" | "powershell";

export const zshQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
// PowerShell also ends a single-quoted string at the curly quotes U+2018 to U+201B.
export const psQuote = (s: string) => `'${s.replace(/['\u2018-\u201b]/g, "$&$&")}'`;

function zsh(lastdir: string): string[] {
  return [
    "HISTFILE=${HISTFILE:-${ZDOTDIR:-$HOME}/.zsh_history}",
    "(( HISTSIZE < 100000 )) && HISTSIZE=100000",
    "(( SAVEHIST < 100000 )) && SAVEHIST=100000",
    "setopt HIST_IGNORE_ALL_DUPS HIST_SAVE_NO_DUPS HIST_IGNORE_SPACE INC_APPEND_HISTORY",
    `__ssl_lastdir=${zshQuote(lastdir)}`,
    "__ssl_save_dir() {",
    "  [[ -o interactive && -z $CLAUDECODE ]] || return 0",
    '  mkdir -p -- "${__ssl_lastdir:h}" && print -r -- "$PWD" >| "$__ssl_lastdir"',
    "} 2>/dev/null",
    "autoload -Uz add-zsh-hook",
    "add-zsh-hook chpwd __ssl_save_dir",
    "if [[ $PWD == $HOME && -z $CLAUDECODE && -r $__ssl_lastdir ]]; then",
    '  __ssl_dir=$(<"$__ssl_lastdir")',
    '  [[ -n $__ssl_dir && -d $__ssl_dir ]] && cd -- "$__ssl_dir"',
    "  unset __ssl_dir",
    "fi",
  ];
}

// PowerShell has no chpwd: the folder is saved from Starship's pre-command hook,
// chained after any Invoke-Starship-PreCommand the profile already defines.
function powershell(lastdir: string): string[] {
  return [
    `$global:__sslLastDir = ${psQuote(lastdir)}`,
    "# Not for agents or one-off commands (ssh host 'cmd', pwsh -Command/-File).",
    "$global:__sslSkip = $env:CLAUDECODE -or ([Environment]::GetCommandLineArgs() -match '^[-/](c|command|f|file|e|ec|enc|encodedcommand)$')",
    "if ((Get-Module PSReadLine) -and -not $global:__sslSkip) {",
    "  Set-PSReadLineOption -HistoryNoDuplicates -MaximumHistoryCount 100000",
    "  # Keep only the newest copy of each command in the history file.",
    "  try {",
    "    $h = (Get-PSReadLineOption).HistorySavePath",
    '    $stamp = "$global:__sslLastDir.history"',
    "    $f = Get-Item -LiteralPath $h -ErrorAction Ignore",
    "    $size = [long]0",
    "    if (Test-Path -LiteralPath $stamp) { $null = [long]::TryParse([IO.File]::ReadAllText($stamp), [ref]$size) }",
    "    # Only once it has grown by a quarter since the last pass: most tab starts skip all this.",
    "    if ($f -and ($size -eq 0 -or $f.Length -gt $size * 1.25)) {",
    '      $first = "$h.before-cc-starship"',
    "      if (-not (Test-Path -LiteralPath $first)) { Copy-Item -LiteralPath $h -Destination $first }",
    "      $entries = [Collections.Generic.List[string]]::new(); $cur = $null",
    "      foreach ($line in [IO.File]::ReadAllLines($h)) {",
    '        $cur = if ($null -eq $cur) { $line } else { $cur + "`n" + $line }',
    "        if (-not $line.EndsWith('`')) { $entries.Add($cur); $cur = $null }",
    "      }",
    "      if ($null -ne $cur) { $entries.Add($cur) }",
    "      $seen = [Collections.Generic.HashSet[string]]::new()",
    "      $keep = [Collections.Generic.List[string]]::new()",
    "      for ($i = $entries.Count - 1; $i -ge 0; $i--) { if ($seen.Add($entries[$i])) { $keep.Add($entries[$i]) } }",
    "      if ($keep.Count -lt $entries.Count) {",
    "        $keep.Reverse()",
    "        $nl = [Environment]::NewLine",
    '        $tmp = "$h.$PID.tmp"',
    "        try {",
    '          [IO.File]::WriteAllText($tmp, (($keep -join "`n") -replace "`n", $nl) + $nl)',
    "          Move-Item -LiteralPath $tmp -Destination $h -Force",
    "        } finally { Remove-Item -LiteralPath $tmp -ErrorAction Ignore }",
    "      }",
    "      [IO.File]::WriteAllText($stamp, [string](Get-Item -LiteralPath $h).Length)",
    "    }",
    "  } catch {}",
    "}",
    "if (-not $global:__sslSkip) {",
    "  $here = $executionContext.SessionState.Path.CurrentLocation",
    "  # Started in home or C:\\Windows (Run box, some launchers): no folder was chosen.",
    '  $plain = $here.ProviderPath -eq $HOME -or ($env:WINDIR -and $here.ProviderPath -like "$env:WINDIR*")',
    "  if ($plain -and (Test-Path -LiteralPath $global:__sslLastDir)) {",
    "    $d = [IO.File]::ReadAllText($global:__sslLastDir).Trim()",
    "    if ($d -and (Test-Path -LiteralPath $d -PathType Container)) { Set-Location -LiteralPath $d }",
    "  }",
    "  $global:__sslSaved = $executionContext.SessionState.Path.CurrentLocation.ProviderPath",
    "  $outer = Get-Item Function:\\Invoke-Starship-PreCommand -ErrorAction Ignore",
    "  if ($outer -and $outer.ScriptBlock.ToString() -notmatch '__sslLastDir') { $global:__sslOuterPreCommand = $outer.ScriptBlock }",
    "  function global:Invoke-Starship-PreCommand {",
    "    if ($global:__sslOuterPreCommand) { & $global:__sslOuterPreCommand }",
    "    $loc = $executionContext.SessionState.Path.CurrentLocation",
    "    if ($loc.Provider.Name -eq 'FileSystem' -and $loc.ProviderPath -ne $global:__sslSaved) {",
    "      $global:__sslSaved = $loc.ProviderPath",
    "      try { [IO.File]::WriteAllText($global:__sslLastDir, $loc.ProviderPath) } catch {}",
    "    }",
    "  }",
    "}",
  ];
}

/** The profile lines for `kind`, saving the folder to `lastdir`. */
export function memoryBlock(kind: ShellKind, lastdir: string): string {
  if (kind === "zsh") return zsh(lastdir).join("\n") + "\n";
  // A script block of its own, so its working variables stay out of the session.
  const [first, ...rest] = powershell(lastdir);
  return [first, "& {", ...rest.map((l) => `  ${l}`), "}"].join("\n") + "\n";
}
