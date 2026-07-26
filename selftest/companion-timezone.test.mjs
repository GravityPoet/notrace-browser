// The timezone spoof rewrites Date methods that pages call constantly, so it
// caches its Intl formatters and the current hour's UTC offset. A cache that
// answers differently from ICU is worse than no spoof at all: the mismatch
// between getTimezoneOffset and Intl is exactly what fingerprinters test for.
//
// These tests pin both halves — the offsets stay ICU-exact across DST
// boundaries, and the hot paths stay far away from the per-call formatter
// construction that used to stall the main thread.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPOOF = readFileSync(join(ROOT, "extension", "cloak-companion", "spoof.js"), "utf8");

function spoofedWindow(zone) {
  const context = vm.createContext({ Intl, Date, Math, Object, String, Array, JSON, Promise });
  vm.runInContext("var window = this;", context);
  context.navigator = { userAgent: "Mozilla/5.0 (Macintosh) Chrome/145.0.0.0 Safari/537.36" };
  vm.runInContext(SPOOF, context);
  vm.runInContext(`window.__cloakSpoof(${JSON.stringify(zone)}, "92934");`, context);
  return context;
}

/// Offset ICU reports for `instant` in `zone`, in getTimezoneOffset's sign
/// convention (minutes behind UTC).
function icuOffset(zone, instant) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = Number(part.value);
    return acc;
  }, {});
  const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return -Math.round((asUTC - instant.getTime()) / 60000);
}

const CASES = [
  // Either side of the 2026 US spring-forward and fall-back transitions.
  ["America/New_York", "2026-03-08T06:59:00Z"],
  ["America/New_York", "2026-03-08T07:01:00Z"],
  ["America/New_York", "2026-11-01T05:59:00Z"],
  ["America/New_York", "2026-11-01T06:01:00Z"],
  // EU transition, a half-hour zone, a no-DST zone, and a pre-1970 instant
  // whose historical offset carries odd minutes.
  ["Europe/Berlin", "2026-03-29T00:59:00Z"],
  ["Europe/Berlin", "2026-03-29T01:01:00Z"],
  ["Australia/Adelaide", "2026-04-04T16:01:00Z"],
  ["Asia/Shanghai", "2026-07-04T12:00:00Z"],
  ["America/New_York", "1960-01-01T00:00:00Z"],
];

for (const [zone, iso] of CASES) {
  test(`getTimezoneOffset matches ICU in ${zone} at ${iso}`, () => {
    const context = spoofedWindow(zone);
    context.probe = new Date(iso);
    const actual = vm.runInContext("probe.getTimezoneOffset()", context);
    assert.equal(actual, icuOffset(zone, new Date(iso)));
  });
}

test("crossing an hour bucket re-reads the offset instead of reusing it", () => {
  const context = spoofedWindow("America/New_York");
  // Warm the cache on standard time, then ask about daylight time.
  context.before = new Date("2026-03-08T06:59:00Z");
  context.after = new Date("2026-03-08T07:01:00Z");

  const standard = vm.runInContext("before.getTimezoneOffset()", context);
  const daylight = vm.runInContext("after.getTimezoneOffset()", context);

  assert.equal(standard, 300);
  assert.equal(daylight, 240, "a stale cache would still report standard time here");
});

test("the hot Date paths stay far cheaper than a formatter per call", () => {
  const context = spoofedWindow("Asia/Shanghai");
  const measure = (expression) => vm.runInContext(
    `(function () {
       for (var w = 0; w < 200; w++) { ${expression} }
       var start = Date.now();
       for (var i = 0; i < 20000; i++) { ${expression} }
       return Date.now() - start;
     })()`,
    context,
  );

  // Constructing an Intl.DateTimeFormat per call cost ~40µs and ~225µs
  // respectively. These ceilings are loose enough for slow CI hardware while
  // still failing loudly if the caching is lost.
  const offsetMs = measure("new Date().getTimezoneOffset();");
  const stringMs = measure("String(new Date());");

  assert.ok(offsetMs < 400, `getTimezoneOffset took ${offsetMs}ms for 20k calls`);
  assert.ok(stringMs < 800, `Date→string took ${stringMs}ms for 20k calls`);
});
