import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import { hookOutput, saveSnapshot, snapshotFile } from "../src/hook.ts";
import { tempDir } from "./helpers.ts";

// Friday, October 23 2026, 23:00 local time.
const now = new Date(2026, 9, 23, 23, 0);
const at = (days: number, h: number) => new Date(2026, 9, 23 + days, h).getTime() / 1000;
const en12 = { language: "en", clock: "12h" } as const;

const payload = {
  session_id: "abc-123",
  context_window: { used_percentage: 65, total_input_tokens: 130000 },
  cost: { total_cost_usd: 4.2 },
  rate_limits: {
    five_hour: { used_percentage: 21, resets_at: at(1, 2) },
    seven_day: { used_percentage: 25.4, resets_at: at(1, 18) },
  },
};

function setup() {
  const dir = tempDir();
  return { sessions: join(dir, "sessions"), usageFile: join(dir, "usage") };
}

const context = (out: string) => {
  const json = JSON.parse(out);
  assertEquals(json.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  return json.hookSpecificOutput.additionalContext as string;
};

Deno.test("hook: the session's last status bar numbers, with reset times", () => {
  const o = setup();
  saveSnapshot(snapshotFile(o.sessions, payload.session_id), payload, now);
  const text = context(
    hookOutput(JSON.stringify({ session_id: "abc-123", prompt: "hi" }), { ...o, prefs: en12, now }),
  );
  for (
    const part of ["context 65%", "130k tokens", "5h 21%", "resets Sat 2 AM", "7d 25%", "resets Sat 6 PM"]
  ) {
    assertStringIncludes(text, part);
  }
});

Deno.test("hook: reset times follow the language and clock", () => {
  const o = setup();
  saveSnapshot(snapshotFile(o.sessions, payload.session_id), payload, now);
  const text = context(
    hookOutput(JSON.stringify({ session_id: "abc-123" }), {
      ...o,
      prefs: { language: "fr-CA", clock: "24h" },
      now,
    }),
  );
  assertStringIncludes(text, "sam. 18 h");
});

Deno.test("hook: a new session without its own numbers yet falls back to the shared 5h/7d", () => {
  const o = setup();
  Deno.writeTextFileSync(o.usageFile, `${at(1, 2)} 21 ${at(1, 18)} 25\n`);
  const text = context(hookOutput(JSON.stringify({ session_id: "new" }), { ...o, prefs: en12, now }));
  assertStringIncludes(text, "5h 21%");
  assertStringIncludes(text, "7d 25%");
  assert(!text.includes("context"), text);
});

Deno.test("hook: a window whose reset has passed counts as 0%", () => {
  const o = setup();
  const past = {
    ...payload,
    rate_limits: { ...payload.rate_limits, five_hour: { used_percentage: 97, resets_at: at(0, 22) } },
  };
  saveSnapshot(snapshotFile(o.sessions, payload.session_id), past, now);
  const text = context(hookOutput(JSON.stringify({ session_id: "abc-123" }), { ...o, prefs: en12, now }));
  assertStringIncludes(text, "5h 0%");
});

Deno.test("hook: nothing known, nothing printed; bad input never fails the prompt", () => {
  const o = setup();
  assertEquals(hookOutput(JSON.stringify({ session_id: "x" }), { ...o, prefs: en12, now }), "");
  assertEquals(hookOutput("not json", { ...o, prefs: en12, now }), "");
});

Deno.test("hook: a session id can't point outside the sessions folder", () => {
  const o = setup();
  const file = snapshotFile(o.sessions, "../../etc/passwd");
  assert(file.startsWith(o.sessions + "/") || file.startsWith(o.sessions + "\\"), file);
  assert(!file.slice(o.sessions.length + 1).includes(".."), file);
});

Deno.test("hook threshold: silent (0 tokens) until context, 5h or 7d reaches it", () => {
  const o = setup();
  saveSnapshot(snapshotFile(o.sessions, payload.session_id), payload, now); // 65 / 21 / 25
  const run = (from: number) =>
    hookOutput(JSON.stringify({ session_id: "abc-123" }), { ...o, prefs: en12, now, from });
  assertEquals(run(70), "", "everything below 70%");
  assertStringIncludes(context(run(50)), "context 65%", "context crossed 50%: the whole line");
  assertStringIncludes(context(run(50)), "7d 25%");
  assertStringIncludes(context(run(0)), "5h 21%", "0 means every prompt");
});

Deno.test("hook: time left until each reset", () => {
  const o = setup();
  const p = {
    ...payload,
    rate_limits: {
      five_hour: { used_percentage: 21, resets_at: at(1, 2) - 50 * 60 },
      seven_day: { used_percentage: 25, resets_at: at(3, 5) },
    },
  };
  saveSnapshot(snapshotFile(o.sessions, payload.session_id), p, now);
  const text = context(hookOutput(JSON.stringify({ session_id: "abc-123" }), { ...o, prefs: en12, now }));
  assertStringIncludes(text, "(in 2h 10m)"); // 23:00 → 01:10
  assertStringIncludes(text, "(in 2d 6h)"); // 23:00 → Mon 05:00
});

Deno.test("hook: odd input (null, a number) prints nothing instead of failing the prompt", () => {
  const o = setup();
  for (const input of ["null", "42", '"text"', "[]"]) {
    assertEquals(hookOutput(input, { ...o, prefs: en12, now, from: 0 }), "", input);
  }
});

Deno.test("hook: newer shared 5h/7d numbers win over an old session snapshot (resumed session)", () => {
  const o = setup();
  const file = snapshotFile(o.sessions, payload.session_id);
  saveSnapshot(file, payload, new Date(now.getTime() - 3 * 3600e3)); // 3 h old: 5h 21%
  Deno.writeTextFileSync(o.usageFile, `${at(1, 2)} 64 ${at(1, 18)} 30\n`);
  const old = new Date(now.getTime() - 3 * 3600e3);
  Deno.utimeSync(file, old, old);
  const text = context(
    hookOutput(JSON.stringify({ session_id: "abc-123" }), { ...o, prefs: en12, now, from: 0 }),
  );
  assertStringIncludes(text, "5h 64%");
  assertStringIncludes(text, "7d 30%");
  assertStringIncludes(text, "context 65%", "context still comes from the session");
});
