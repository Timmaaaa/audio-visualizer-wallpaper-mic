/* ─── Simple Visualizer – viz.js ──────────────────────────────────────────
   Dynamic source switching:
   • Primary  → livelyAudioListener (Lively Wallpaper system-audio API)
   • Fallback → microphone via Web Audio API / getUserMedia
   Switching rules:
     silence on system-audio for >= SILENCE_FRAMES_REQUIRED frames → activate mic
     any non-silent frame from lively                              → deactivate mic
   ─────────────────────────────────────────────────────────────────────────── */

'use strict';

// ── Canvas / render state ──────────────────────────────────────────────────
const canvas = document.getElementById('canvas');
const ctx    = canvas.getContext('2d');

let max_height, startPos, vizWidth, midY, gradient;
let backgroundColor = 'rgb(0,0,0)';
let linesColor      = 'rgb(255,0,0)';
let square          = true;

// ── Switching / silence detection ─────────────────────────────────────────
const SILENCE_THRESHOLD       = 0.01;  // bin value below which a frame counts as silent
const SILENCE_FRAMES_REQUIRED = 45;   // ~1.5 s at 30 fps before mic kicks in

let silentFrameCount  = 0;
let micActive         = false;
let micInitialized    = false;
let micAnalyser       = null;
let micDataArray      = null;
let micAnimFrame      = null;
let audioCtx          = null;

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
  max_height = window.innerHeight * 0.5;
  startPos   = window.innerWidth  * 0.1;
  vizWidth   = window.innerWidth  * 0.8;
  midY       = canvas.height - canvas.height / 4;
  gradient   = ctx.createLinearGradient(0, midY, 0, midY - max_height);
  gradient.addColorStop(0, backgroundColor);
  gradient.addColorStop(1, linesColor);
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
    case 'square':
      square = val;
      break;
  }
}
function _rebuildGradient() {
  gradient = ctx.createLinearGradient(0, midY, 0, midY - max_height);
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
    // System audio has signal → be the authoritative source
    if (micActive) _deactivateMic();
    silentFrameCount = 0;
    _renderFrame(audioArray);
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
      audioCtx      = new (window.AudioContext || window.webkitAudioContext)();
      const source  = audioCtx.createMediaStreamSource(stream);
      micAnalyser   = audioCtx.createAnalyser();
      micAnalyser.fftSize = 128;
      source.connect(micAnalyser);
      micDataArray  = new Float32Array(micAnalyser.frequencyBinCount);
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
  function tick() {
    if (!micActive) return;
    micAnalyser.getFloatFrequencyData(micDataArray);
    // getFloatFrequencyData returns dB values (-Infinity … 0).
    // Normalise to 0–1 range matching lively's audioArray format.
    const normalised = _normaliseMicData(micDataArray);
    _renderFrame(normalised);
    micAnimFrame = requestAnimationFrame(tick);
  }
  micAnimFrame = requestAnimationFrame(tick);
}

function _normaliseMicData(dbArray) {
  const MIN_DB = -100;
  const MAX_DB = -10;
  const range  = MAX_DB - MIN_DB;
  const out    = new Float32Array(dbArray.length);
  for (let i = 0; i < dbArray.length; i++) {
    out[i] = Math.max(0, Math.min(1, (dbArray[i] - MIN_DB) / range));
  }
  return out;
}

// ── Renderer ──────────────────────────────────────────────────────────────
function _renderFrame(audioArray) {
  let maxVal = 1;
  for (const x of audioArray) {
    if (x > maxVal) maxVal = x;
  }

  const offSet = vizWidth / audioArray.length;
  const posLen = audioArray.length;

  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.beginPath();
  ctx.lineJoin = 'round';
  ctx.moveTo(startPos - offSet * 3, midY);
  ctx.lineTo(startPos, midY);

  let posInLine = -1;
  for (let x = 0; x < posLen; x++) {
    posInLine++;
    ctx.lineTo(
      startPos + offSet * posInLine,
      midY - (audioArray[x] / maxVal) * max_height
    );
    if (square) {
      ctx.lineTo(
        startPos + offSet * (posInLine + 1),
        midY - (audioArray[x] / maxVal) * max_height
      );
    }
  }
  ctx.lineTo(startPos + offSet * (posInLine + (square ? 1 : 0)), midY);
  ctx.lineTo(startPos + offSet * (posInLine + (square ? 4 : 3)), midY);

  ctx.fillStyle = gradient;
  ctx.fill();
  _renderLine(linesColor);
}

function _renderLine(color) {
  ctx.lineWidth   = 2;
  ctx.strokeStyle = color;
  ctx.stroke();
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

// ── Test-surface exports (stripped in production by checking env) ──────────
/* istanbul ignore next */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    _isSilentArray,
    _normaliseMicData,
    livelyAudioListener,
    _get: () => ({ silentFrameCount, micActive, SILENCE_THRESHOLD, SILENCE_FRAMES_REQUIRED })
  };
}
