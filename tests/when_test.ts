import { assertEquals } from "@std/assert";
import { formatWhen, resolvePrefs } from "../src/when.ts";

// Friday, October 23 2026, 23:00 local time.
const now = new Date(2026, 9, 23, 23, 0);
const at = (days: number, h: number, m = 0) => new Date(2026, 9, 23 + days, h, m);
const en24 = { language: "en", clock: "24h" } as const;
const en12 = { language: "en", clock: "12h" } as const;
const fr24 = { language: "fr-CA", clock: "24h" } as const;
const fr12 = { language: "fr-CA", clock: "12h" } as const;

Deno.test("today shows only the time", () => {
  assertEquals(formatWhen(at(0, 23, 45), now, en24), "23:45");
  assertEquals(formatWhen(at(0, 23, 45), now, en12), "11:45 PM");
  assertEquals(formatWhen(at(0, 23, 45), now, fr24), "23 h 45");
});

Deno.test("tomorrow says so, even when it is less than 24 hours away", () => {
  assertEquals(formatWhen(at(1, 18), now, en24), "tomorrow 18:00");
  assertEquals(formatWhen(at(1, 18), now, en12), "tomorrow 6:00 PM");
  assertEquals(formatWhen(at(1, 18), now, fr24), "demain 18 h");
  assertEquals(formatWhen(at(1, 9, 5), now, fr24), "demain 9 h 05");
  assertEquals(formatWhen(at(1, 18, 30), now, fr12), "demain 6 h 30 p.m.");
});

Deno.test("within the week: the weekday", () => {
  assertEquals(formatWhen(at(2, 3, 33), now, en24), "Sun 03:33");
  assertEquals(formatWhen(at(2, 3, 33), now, en12), "Sun 3:33 AM");
  assertEquals(formatWhen(at(2, 3, 33), now, fr24), "dim. 3 h 33");
  assertEquals(formatWhen(at(6, 12), now, fr24), "jeu. 12 h");
});

Deno.test("a week or more away: the date", () => {
  assertEquals(formatWhen(at(7, 18), now, en24), "Oct 30 18:00");
  assertEquals(formatWhen(at(10, 0, 15), now, en12), "Nov 2 12:15 AM");
  assertEquals(formatWhen(at(7, 18), now, fr24), "30 oct. 18 h");
  assertEquals(formatWhen(new Date(2026, 7, 2, 8), new Date(2026, 6, 20), fr24), "2 août 8 h");
});

Deno.test("auto picks language and clock from the system locale", () => {
  assertEquals(resolvePrefs({ language: "auto", clock: "auto" }, "fr-CA"), {
    language: "fr-CA",
    clock: "24h",
  });
  assertEquals(resolvePrefs({ language: "auto", clock: "auto" }, "en-US"), { language: "en", clock: "12h" });
  assertEquals(resolvePrefs({ language: "auto", clock: "auto" }, "en-GB"), { language: "en", clock: "24h" });
  assertEquals(resolvePrefs({ language: "auto", clock: "auto" }, "de-DE"), { language: "en", clock: "24h" });
  assertEquals(resolvePrefs({ language: "en", clock: "12h" }, "fr-CA"), { language: "en", clock: "12h" });
});
