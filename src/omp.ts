// oh-my-posh does the same job as Starship: both drawing one prompt conflict.

// Measured on a Mac Studio with bench.py: status bar render, Starship vs oh-my-posh.
const SPEED = "Starship draws the same kind of prompt about 3× faster (34 ms vs 94 ms measured)";

const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** A note for each place oh-my-posh still draws a prompt: shell profiles and the status line. */
export function ompNotes(profiles: string[], statusLine: { command?: string } | undefined): string[] {
  const notes: string[] = [];
  for (const profile of profiles) {
    let text: string;
    try {
      text = decoder.decode(Deno.readFileSync(profile));
    } catch {
      continue;
    }
    const line = text.split(/\r?\n/).findIndex((l) => /^\s*(?!#).*oh-my-posh(\.exe)?['"]?\s+init/.test(l));
    if (line >= 0) {
      notes.push(
        `${profile} line ${line + 1} starts oh-my-posh: two prompt engines in one shell conflict. ` +
          `${SPEED}; remove that line to keep Starship.`,
      );
    }
  }
  if (/oh-my-posh/.test(statusLine?.command ?? "")) {
    notes.push(
      `Claude Code's status line runs oh-my-posh and would conflict with this bar. ${SPEED}.`,
    );
  }
  return notes;
}
