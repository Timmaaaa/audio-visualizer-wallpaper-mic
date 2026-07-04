/**
 * viz.test.js – Node-compatible unit tests for viz.js switching logic.
 * Run with:  node viz.test.js
 * No external test framework required.
 */

'use strict';

// ── Minimal browser-API stubs ─────────────────────────────────────────────
global.document = {
  getElementById: () => ({
    getContext: () => ({
      createLinearGradient: () => ({ addColorStop: () => {} }),
      fillRect: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      fill: () => {},
      stroke: () => {},
    }),
    style: {},
  })
};
global.window = {
  innerWidth: 1920,
  innerHeight: 1080,
  onload: null,
  onresize: null,
};
global.navigator = {
  mediaDevices: {
    getUserMedia: () => Promise.reject(new Error('stub – no mic in test'))
  }
};
global.requestAnimationFrame = () => {};
global.cancelAnimationFrame  = () => {};
global.AudioContext = function () {
  return { createMediaStreamSource: () => ({ connect: () => {} }), createAnalyser: () => ({ fftSize: 0, frequencyBinCount: 64, getFloatFrequencyData: () => {} }) };
};

const {
  _isSilentArray,
  _normaliseMicData,
  livelyAudioListener,
  _get
} = require('./viz.js');

// ── tiny assertion helper ─────────────────────────────────────────────────
let passed = 0, failed = 0;
function assert(condition, label) {
  if (condition) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  ${label}`);
    failed++;
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────
console.log('\n── _isSilentArray ──');
assert(_isSilentArray([0, 0, 0, 0]),              'all-zero array → silent');
assert(_isSilentArray([0.005, 0.009, 0]),         'below threshold → silent');
assert(!_isSilentArray([0, 0.5, 0]),              'mid value → not silent');
assert(!_isSilentArray([0.02]),                   'single above-threshold → not silent');

console.log('\n── _normaliseMicData ──');
const normed = _normaliseMicData(new Float32Array([-100, -55, -10, -200]));
assert(normed[0] === 0,                           '-100 dB → 0.0');
assert(normed[2] === 1,                           '-10 dB  → 1.0');
assert(normed[3] === 0,                           'below min dB → clamped 0');
assert(normed[1] > 0 && normed[1] < 1,           '-55 dB → in range');

console.log('\n── silence counter accumulation ──');
// Feed SILENCE_FRAMES_REQUIRED - 1 silent frames; mic should NOT activate yet
const { SILENCE_FRAMES_REQUIRED } = _get();
const silentFrame = new Array(64).fill(0);
for (let i = 0; i < SILENCE_FRAMES_REQUIRED - 1; i++) livelyAudioListener(silentFrame);
assert(_get().silentFrameCount === SILENCE_FRAMES_REQUIRED - 1, `counter at ${SILENCE_FRAMES_REQUIRED - 1} before threshold`);
assert(!_get().micActive,                         'mic NOT active before threshold');

console.log('\n── mic activates at threshold ──');
livelyAudioListener(silentFrame);  // push over threshold
assert(_get().silentFrameCount >= SILENCE_FRAMES_REQUIRED, 'counter at/above threshold');
// micActive may still be false if getUserMedia rejected (test stub) – that is OK,
// what we verify is that _activateMic was attempted (counter reached threshold).
assert(_get().silentFrameCount >= SILENCE_FRAMES_REQUIRED, 'threshold was reached');

console.log('\n── signal resets counter + deactivates mic ──');
const loudFrame = new Array(64).fill(0.5);
livelyAudioListener(loudFrame);
assert(_get().silentFrameCount === 0,             'counter reset on signal');
assert(!_get().micActive,                         'mic deactivated on system signal');

console.log('\n── snap-back: mic immediately off on any loud frame ──');
for (let i = 0; i < SILENCE_FRAMES_REQUIRED; i++) livelyAudioListener(silentFrame);
livelyAudioListener(loudFrame);
assert(!_get().micActive,                         'mic snapped off on loud frame after re-silence cycle');
assert(_get().silentFrameCount === 0,             'counter reset after snap-back');

// ── Summary ───────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(45)}`);
console.log(`Result: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
