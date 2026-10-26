import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import {
  checkDue,
  newerVersion,
  offerUpdate,
  readUpdateCache,
  saveUpdateCheck,
  tagFromLocation,
} from "../src/update.ts";
import { tempDir } from "./helpers.ts";

Deno.test("update: the newest release is read from where releases/latest redirects", () => {
  assertEquals(tagFromLocation("https://github.com/iFredOS/cc-starship/releases/tag/v1.0.2"), "1.0.2");
  assertEquals(tagFromLocation(null), null);
  assertEquals(
    tagFromLocation("https://github.com/login?return_to=x"),
    null,
    "a private repo: no release to see",
  );
});

Deno.test("update: only a newer version counts", () => {
  assertEquals(newerVersion({ checked: 0, latest: "1.0.2" }, "1.0.1"), "1.0.2");
  assertEquals(newerVersion({ checked: 0, latest: "1.0.1" }, "1.0.1"), null);
  assertEquals(newerVersion({ checked: 0, latest: "0.9.0" }, "1.0.1"), null);
  assertEquals(newerVersion({ checked: 0, latest: null }, "1.0.1"), null);
  assertEquals(newerVersion(null, "1.0.1"), null);
});

Deno.test("update: checked at most once a day", () => {
  const now = Date.parse("2026-10-26T12:00:00Z");
  const hour = 3600_000;
  assert(checkDue(null, now));
  assert(!checkDue({ checked: now - 23 * hour, latest: null }, now));
  assert(checkDue({ checked: now - 25 * hour, latest: null }, now));
  assert(
    checkDue({ checked: now + hour, latest: null }, now),
    "a clock set back doesn't stop checks for good",
  );
});

Deno.test("update: the answer is saved; a check that couldn't reach GitHub keeps the last one", () => {
  const file = join(tempDir(), "update.json");
  saveUpdateCheck(file, "1.0.2", 1000);
  assertEquals(readUpdateCache(file), { checked: 1000, latest: "1.0.2" });
  saveUpdateCheck(file, undefined, 2000); // offline: nothing learned
  assertEquals(readUpdateCache(file), { checked: 2000, latest: "1.0.2" });
  saveUpdateCheck(file, null, 3000); // reached GitHub: no release to see
  assertEquals(readUpdateCache(file), { checked: 3000, latest: null });
  Deno.writeTextFileSync(file, "not json");
  assertEquals(readUpdateCache(file), null);
});

Deno.test("update: a downloaded copy newer than the installed one offers to update it", () => {
  assertEquals(offerUpdate("1.0.2", "1.0.1"), true);
  assertEquals(offerUpdate("1.0.1", "1.0.1"), false);
  assertEquals(offerUpdate("1.0.0", "1.0.1"), false, "never a downgrade");
  assertEquals(offerUpdate("1.0.2", null), false, "installed version unknown");
});
