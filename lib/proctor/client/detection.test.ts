/** Detection logic tests. Run with: npm test */
import assert from "node:assert/strict";
import { test } from "node:test";

import { dockedDevtoolsSuspected } from "./heuristics.ts";
import { Sustained } from "./sustained.ts";

function recorder(minMs: number, clearMs: number, graceMs: number) {
  const log: string[] = [];
  const s = new Sustained<void>(minMs, { start: () => log.push("start"), end: (ms) => log.push(`end:${Math.round(ms)}`) }, clearMs, graceMs);
  return { s, log };
}

/** Feeds frames every `step` ms; `pattern(i)` is the condition for frame i. */
function feed(s: Sustained<void>, frames: number, step: number, pattern: (i: number) => boolean) {
  for (let i = 0; i < frames; i++) s.update(pattern(i), i * step);
}

test("a real 3 s head turn with flickering frames is reported (the bug)", () => {
  // Condition true except every 5th frame, as noisy pose estimates do near the threshold.
  const flicker = (i: number) => i % 5 !== 4;
  const without = recorder(1_500, 800, 0);
  feed(without.s, 20, 150, flicker);
  assert.deepEqual(without.log, [], "without grace, one missed frame restarts the timer forever");

  const withGrace = recorder(1_500, 800, 450);
  feed(withGrace.s, 20, 150, flicker);
  assert.deepEqual(withGrace.log, ["start"]);
});

test("short glances below the minimum duration are still ignored", () => {
  const { s, log } = recorder(1_500, 800, 450);
  feed(s, 40, 150, (i) => i % 10 < 6); // 0.9 s on, 0.6 s off, repeatedly
  assert.deepEqual(log, []);
});

test("a condition ends only after it has cleared, with its full duration", () => {
  const { s, log } = recorder(1_500, 800, 450);
  feed(s, 60, 100, (i) => i < 30); // true for 3 s
  assert.deepEqual(log, ["start", "end:3000"]);
});

test("DevTools: uniform shrink (browser zoom / display scaling) is not flagged", () => {
  // The attempt that was wrongly flagged: 210 px narrower and 127 px shorter on a 1680×1050 screen.
  const r = dockedDevtoolsSuspected({ innerWidth: 1470, innerHeight: 923, screenWidth: 1680, screenHeight: 1050, zoom: 1 });
  assert.equal(r.suspected, false);
  assert.equal(r.widthGap, 210);
});

test("DevTools docked to the side or bottom is flagged; a full-size viewport is not", () => {
  assert.equal(dockedDevtoolsSuspected({ innerWidth: 1180, innerHeight: 1050, screenWidth: 1680, screenHeight: 1050, zoom: 1 }).suspected, true);
  assert.equal(dockedDevtoolsSuspected({ innerWidth: 1680, innerHeight: 700, screenWidth: 1680, screenHeight: 1050, zoom: 1 }).suspected, true);
  assert.equal(dockedDevtoolsSuspected({ innerWidth: 1680, innerHeight: 1050, screenWidth: 1680, screenHeight: 1050, zoom: 1 }).suspected, false);
});
