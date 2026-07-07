/* ─── Simple Visualizer – viz.js ──────────────────────────────────────────
 Dynamic source switching:
 • Primary  → livelyAudioListener (Lively Wallpaper system-audio API)
 • Fallback → microphone via Web Audio API / getUserMedia
 Switching rules:
   silence on system-audio for >= SILENCE_FRAMES_REQUIRED frames → activate mic
   any non-silent frame from lively                              → deactivate mic

 Spectrum Analyzer mode:
 • Frequency axis is logarithmic so that 1 kHz lands exactly in the centre
 • Bars grow from the bottom up (classic spectrum analyser style)
 • dB range: MIN_DB … 0 dB mapped to bar height
 ─────────────────────────────────────────────────────────────────────────── */
'use strict';

// ── Canvas / render state ──────────────────────────────────────────────────
const canvas = document.getElementById('canvas');
const ctx    = canvas.getContext('2d');

let canvasW, canvasH, max_height, gradient;
let backgroundColor = 'rgb(0,0,0)';
let linesColor      = 'rgb(255,0,0)';

// ── Spectrum config ───────────────────────────────────────────────────────
const SAMPLE_RATE   = 44100;          // assumed sample rate (Hz)
const FFT_SIZE_MIC  = 2048;          // analyser fftSize for mic path
const MIN_FREQ      = 20;            // Hz – left edge
const MAX_FREQ      = 20000;         // Hz – right edge
const CENTER_FREQ   = 1000;          // Hz – must land at canvas centre
const MIN_DB        = -90;           // dB floor
const MAX_DB        = 0;             // dB ceiling
const BAR_GAP       = 1;             // px gap between bars

// ── Switching / silence detection ─────────────────────────────────────────
const SILENCE_THRESHOLD      = 0.01;
const SILENCE_FRAMES_REQUIRED = 45;

let silentFrameCount = 0;
let micActive        = false;
let micInitialized   = false;
let micAnalyser      = null;
let micDataArray     = null;
let micAnimFrame     = null;
let audioCtx         = null;

// ── HUD ───────────────────────────────────────────────────────────────────
const hud = document.getElementById('hud');
function updateHUD() {
  if (!hud) return;
  hud.textContent = micActive
    ? `SRC: MIC  | silent: ${silentFrameCount}`
    : `SRC: SYSTEM | silent: ${silentFrameCount}`;
}

// ── Layout ────────────────────────────────────────────────────────────────
function setSize() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  canvasW    = canvas.width;
  canvasH    = canvas.height;
  max_height = canvasH * 0.9;
  _rebuildGradient();
}
window.onload  = setSize;
window.onresize = setSize;

// ── Lively property bridge ────────────────────────────────────────────────
function livelyPropertyListener(name, val) {
  switch (name) {
    case 'lineColor': {
      const c = hexToRgb(val);
      linesColor = `rgb(${c.r},${c.g},${c.b})`;
      _rebuildGradient();
      break;
    }
    case 'backgroundColor': {
      const c = hexToRgb(val);
      backgroundColor = `rgb(${c.r},${c.g},${c.b})`;
      _rebuildGradient();
      break;
    }
  }
}
function _rebuildGradient() {
  if (!canvasH) return;
  gradient = ctx.createLinearGradient(0, canvasH, 0, canvasH - max_height);
  gradient.addColorStop(0, backgroundColor);
  gradient.addColorStop(1, linesColor);
}

// ── Core: Lively audio callback (system audio) ────────────────────────────
function livelyAudioListener(audioArray) {
  const isSilent = _isSilentArray(audioArray);
  if (isSilent) {
    silentFrameCount = Math.min(silentFrameCount + 1, SILENCE_FRAMES_REQUIRED + 1);
    if (silentFrameCount >= SILENCE_FRAMES_REQUIRED && !micActive) {
      _activateMic();
    }
  } else {
    if (micActive) _deactivateMic();
    silentFrameCount = 0;
    _renderSpectrum(audioArray, SAMPLE_RATE / 2, audioArray.length);
  }
  updateHUD();
}

// ── Silence detection helper ──────────────────────────────────────────────
function _isSilentArray(arr) {
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] > SILENCE_THRESHOLD) return false;
  }
  return true;
}

// ── Mic management ────────────────────────────────────────────────────────
function _activateMic() {
  if (micActive) return;
  micActive = true;
  if (micInitialized && micAnalyser) {
    _startMicLoop();
    return;
  }
  navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    .then(stream => {
      audioCtx    = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(stream);
      micAnalyser  = audioCtx.createAnalyser();
      micAnalyser.fftSize    = FFT_SIZE_MIC;
      micAnalyser.minDecibels = MIN_DB;
      micAnalyser.maxDecibels = MAX_DB;
      source.connect(micAnalyser);
      micDataArray   = new Float32Array(micAnalyser.frequencyBinCount);
      micInitialized = true;
      _startMicLoop();
    })
    .catch(err => {
      console.warn('[viz] Mic access denied or unavailable:', err);
      micActive = false;
    });
}
function _deactivateMic() {
  micActive = false;
  if (micAnimFrame) {
    cancelAnimationFrame(micAnimFrame);
    micAnimFrame = null;
  }
}
function _startMicLoop() {
  const nyquist = audioCtx.sampleRate / 2;
  const binCount = micAnalyser.frequencyBinCount;
  function tick() {
    if (!micActive) return;
    micAnalyser.getFloatFrequencyData(micDataArray);
    _renderSpectrum(micDataArray, nyquist, binCount, true);
    updateHUD();
    micAnimFrame = requestAnimationFrame(tick);
  }
  micAnimFrame = requestAnimationFrame(tick);
}

// ── Spectrum renderer ─────────────────────────────────────────────────────
// audioArray : Float32Array – either 0-1 values (lively) or dB values (mic)
// nyquist    : highest frequency represented (Hz)
// binCount   : number of bins in audioArray
// isDb       : true → values are dB, false → values are 0-1 linear
function _renderSpectrum(audioArray, nyquist, binCount, isDb) {
  if (!canvasW) return;

  // Clear
  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, canvasW, canvasH);

  // ── Build logarithmic frequency mapping ──────────────────────────────
  // We want MIN_FREQ on the left, MAX_FREQ on the right,
  // with CENTER_FREQ exactly at canvasW/2.
  //
  // Use a two-segment log scale:
  //   left half  : MIN_FREQ … CENTER_FREQ
  //   right half : CENTER_FREQ … MAX_FREQ
  const midX = canvasW / 2;

  // Precompute how many display columns we draw
  const numBars = Math.floor(canvasW / (1 + BAR_GAP));

  ctx.beginPath();
  let firstBar = true;

  for (let i = 0; i < numBars; i++) {
    const px = i * (1 + BAR_GAP);

    // Map pixel position → frequency (log scale, 1 kHz at centre)
    let freq;
    if (px <= midX) {
      // left half: MIN_FREQ … CENTER_FREQ
      const t = px / midX;  // 0 … 1
      freq = MIN_FREQ * Math.pow(CENTER_FREQ / MIN_FREQ, t);
    } else {
      // right half: CENTER_FREQ … MAX_FREQ
      const t = (px - midX) / midX;  // 0 … 1
      freq = CENTER_FREQ * Math.pow(MAX_FREQ / CENTER_FREQ, t);
    }

    // Map frequency → bin index
    const binIndex = Math.min(
      Math.round((freq / nyquist) * binCount),
      binCount - 1
    );

    // Normalise value to 0-1
    let norm;
    if (isDb) {
      norm = Math.max(0, Math.min(1,
        (audioArray[binIndex] - MIN_DB) / (MAX_DB - MIN_DB)
      ));
    } else {
      // lively gives 0-1; treat as linear amplitude → convert to pseudo-dB
      const amp = Math.max(0, audioArray[binIndex]);
      const db  = amp > 0 ? 20 * Math.log10(amp) : MIN_DB;
      norm = Math.max(0, Math.min(1,
        (db - MIN_DB) / (MAX_DB - MIN_DB)
      ));
    }

    const barH = norm * max_height;
    const y    = canvasH - barH;

    if (firstBar) {
      ctx.moveTo(px, canvasH);
      firstBar = false;
    }
    ctx.rect(px, y, 1, barH);
  }

  ctx.fillStyle = gradient;
  ctx.fill();
}

// ── Utility ───────────────────────────────────────────────────────────────
function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}

// ── Test-surface exports ──────────────────────────────────────────────────
/* istanbul ignore next */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    _isSilentArray,
    livelyAudioListener,
    _renderSpectrum,
    _get: () => ({ silentFrameCount, micActive, SILENCE_THRESHOLD, SILENCE_FRAMES_REQUIRED }),
  };
}
