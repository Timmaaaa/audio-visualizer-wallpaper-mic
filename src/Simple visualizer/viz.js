/* --- Simple Visualizer - viz.js ------------------------------------------
  Dynamic source switching:
    Primary  -> livelyAudioListener (Lively Wallpaper system-audio API)
    Fallback -> microphone via Web Audio API / getUserMedia
  Switching: silence >= 45 frames -> mic ON | any signal -> mic OFF
  Spectrum Analyzer:
    Log frequency axis, 1 kHz exactly at canvas centre
    Bars grow bottom-up, dB scale MIN_DB..0
    Frequency legend labels at key frequencies
    Peak-hold line per bar with configurable fall direction
  FIXES: setSize called immediately + clearRect + per-bar fillRect
*/
'use strict';

// -- Canvas / render state --------------------------------------------------
const canvas = document.getElementById('canvas');
const ctx    = canvas.getContext('2d');

let canvasW = 0, canvasH = 0, max_height = 0, gradient = null;
let backgroundColor = 'rgb(0,0,0)';
let linesColor      = 'rgb(255,0,0)';

// -- Spectrum config --------------------------------------------------------
const FFT_SIZE_MIC  = 2048;
const MIN_FREQ      = 20;
const MAX_FREQ      = 20000;
const CENTER_FREQ   = 1000;
const MIN_DB        = -90;
const MAX_DB        = 0;
const BAR_GAP       = 1;

// -- Peak hold config -------------------------------------------------------
const PEAK_HOLD_FRAMES = 60;
const PEAK_FALL_SPEED  = 0.008;
let   peakDirection    = 'down';

// per-bar peak state: { norm, hold }
let peakData = [];

// -- Frequency legend markers -----------------------------------------------
const LEGEND_FREQS = [
  20, 60, 100, 150, 300, 500, 1000, 2000, 4000, 6000, 10000, 13000, 20000
];
const LEGEND_LABELS = [
  '20Hz','60Hz','100Hz','150Hz','300Hz','500Hz',
  '1kHz','2kHz','4kHz','6kHz','10kHz','13kHz','20kHz'
];

// -- Switching / silence detection ------------------------------------------
const SILENCE_THRESHOLD       = 0.01;
const SILENCE_FRAMES_REQUIRED = 45;

let silentFrameCount = 0;
let micActive        = false;
let micInitialized   = false;
let micAnalyser      = null;
let micDataArray     = null;
let micAnimFrame     = null;
let audioCtx         = null;

// -- HUD --------------------------------------------------------------------
const hud = document.getElementById('hud');
function updateHUD() {
  if (!hud) return;
  hud.textContent = (micActive ? 'SRC: MIC' : 'SRC: SYSTEM') +
    ' | silent: ' + silentFrameCount;
}

// -- Layout -----------------------------------------------------------------
function setSize() {
  canvas.width  = window.innerWidth  || 1920;
  canvas.height = window.innerHeight || 1080;
  canvasW    = canvas.width;
  canvasH    = canvas.height;
  max_height = canvasH * 0.85;
  peakData   = [];
  _rebuildGradient();
}
setSize();
window.onload   = setSize;
window.onresize = setSize;

// -- Lively property bridge -------------------------------------------------
function livelyPropertyListener(name, val) {
  switch (name) {
    case 'lineColor': {
      const c = hexToRgb(val);
      if (c) { linesColor = 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')'; }
      _rebuildGradient();
      break;
    }
    case 'backgroundColor': {
      const c = hexToRgb(val);
      if (c) { backgroundColor = 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')'; }
      _rebuildGradient();
      break;
    }
    case 'peakDirection':
      peakDirection = (val === 'up') ? 'up' : 'down';
      break;
  }
}

function _rebuildGradient() {
  if (!canvasH) return;
  gradient = ctx.createLinearGradient(0, canvasH, 0, canvasH - max_height);
  gradient.addColorStop(0, linesColor);
  gradient.addColorStop(1, backgroundColor);
}

// -- Core: Lively audio callback --------------------------------------------
function livelyAudioListener(audioArray) {
  if (_isSilentArray(audioArray)) {
    silentFrameCount = Math.min(silentFrameCount + 1, SILENCE_FRAMES_REQUIRED + 1);
    if (silentFrameCount >= SILENCE_FRAMES_REQUIRED && !micActive) _activateMic();
  } else {
    if (micActive) _deactivateMic();
    silentFrameCount = 0;
    _renderSpectrum(audioArray, 22050, audioArray.length, false);
  }
  updateHUD();
}

// -- Silence detection ------------------------------------------------------
function _isSilentArray(arr) {
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] > SILENCE_THRESHOLD) return false;
  }
  return true;
}

// -- Mic management ---------------------------------------------------------
function _activateMic() {
  if (micActive) return;
  micActive = true;
  if (micInitialized && micAnalyser) { _startMicLoop(); return; }
  navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    .then(function(stream) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(stream);
      micAnalyser = audioCtx.createAnalyser();
      micAnalyser.fftSize     = FFT_SIZE_MIC;
      micAnalyser.minDecibels = MIN_DB;
      micAnalyser.maxDecibels = MAX_DB;
      source.connect(micAnalyser);
      micDataArray   = new Float32Array(micAnalyser.frequencyBinCount);
      micInitialized = true;
      _startMicLoop();
    })
    .catch(function(err) {
      console.warn('[viz] Mic unavailable:', err);
      micActive = false;
    });
}

function _deactivateMic() {
  micActive = false;
  if (micAnimFrame) { cancelAnimationFrame(micAnimFrame); micAnimFrame = null; }
}

function _startMicLoop() {
  const nyquist  = audioCtx.sampleRate / 2;
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

// -- Frequency -> pixel X helper --------------------------------------------
function _freqToX(freq) {
  const midX = canvasW / 2;
  if (freq <= CENTER_FREQ) {
    return midX * Math.log(freq / MIN_FREQ) / Math.log(CENTER_FREQ / MIN_FREQ);
  } else {
    return midX + midX * Math.log(freq / CENTER_FREQ) / Math.log(MAX_FREQ / CENTER_FREQ);
  }
}

// -- Spectrum renderer ------------------------------------------------------
function _renderSpectrum(audioArray, nyquist, binCount, isDb) {
  if (!canvasW || !canvasH) { setSize(); }

  ctx.clearRect(0, 0, canvasW, canvasH);
  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, canvasW, canvasH);

  if (!gradient) _rebuildGradient();

  const barW    = 1;
  const step    = barW + BAR_GAP;
  const numBars = Math.floor(canvasW / step);
  const midX    = canvasW / 2;

  while (peakData.length < numBars) peakData.push({ norm: 0, hold: 0 });

  for (let i = 0; i < numBars; i++) {
    const px = i * step;

    let freq;
    if (px <= midX) {
      freq = MIN_FREQ * Math.pow(CENTER_FREQ / MIN_FREQ, px / midX);
    } else {
      freq = CENTER_FREQ * Math.pow(MAX_FREQ / CENTER_FREQ, (px - midX) / midX);
    }

    const binIndex = Math.min(
      Math.round((freq / nyquist) * binCount), binCount - 1
    );

    let norm;
    if (isDb) {
      norm = Math.max(0, Math.min(1,
        (audioArray[binIndex] - MIN_DB) / (MAX_DB - MIN_DB)
      ));
    } else {
      const amp = Math.max(0, audioArray[binIndex]);
      const db  = amp > 0 ? 20 * Math.log10(amp) : MIN_DB;
      norm = Math.max(0, Math.min(1,
        (db - MIN_DB) / (MAX_DB - MIN_DB)
      ));
    }

    const barH = norm * max_height;
    if (barH < 1) continue;
    ctx.fillStyle = gradient;
    ctx.fillRect(px, canvasH - barH, barW, barH);

    const p = peakData[i];
    if (norm >= p.norm) {
      p.norm = norm;
      p.hold = PEAK_HOLD_FRAMES;
    } else {
      if (p.hold > 0) {
        p.hold--;
      } else {
        p.norm = Math.max(0, p.norm - PEAK_FALL_SPEED);
      }
    }
  }

  ctx.lineWidth   = 1.5;
  ctx.strokeStyle = linesColor;
  for (let i = 0; i < numBars; i++) {
    const px = i * step;
    const p  = peakData[i];
    if (p.norm < 0.005) continue;
    let peakY;
    if (peakDirection === 'up') {
      peakY = canvasH - p.norm * max_height - 2;
    } else {
      peakY = canvasH - p.norm * max_height + 2;
    }
    ctx.beginPath();
    ctx.moveTo(px, peakY);
    ctx.lineTo(px + barW, peakY);
    ctx.stroke();
  }

  _drawLegend();
}

// -- Frequency legend -------------------------------------------------------
function _drawLegend() {
  const legendH    = canvasH * 0.06;
  const textY      = canvasH - 6;
  const tickBottom = canvasH;
  const tickTop    = canvasH - legendH;

  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.strokeStyle = linesColor;
  ctx.fillStyle   = linesColor;
  ctx.font        = 'bold ' + Math.max(9, Math.round(canvasH * 0.018)) + 'px monospace';
  ctx.textAlign   = 'center';
  ctx.lineWidth   = 1;

  for (let k = 0; k < LEGEND_FREQS.length; k++) {
    const freq  = LEGEND_FREQS[k];
    const label = LEGEND_LABELS[k];
    const x     = _freqToX(freq);

    ctx.beginPath();
    ctx.moveTo(x, tickBottom);
    ctx.lineTo(x, tickTop);
    ctx.stroke();

    ctx.globalAlpha = 0.85;
    ctx.fillText(label, x, textY);
    ctx.globalAlpha = 0.55;
  }
  ctx.restore();
}

// -- Utility ----------------------------------------------------------------
function hexToRgb(hex) {
  const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return r ? { r: parseInt(r[1],16), g: parseInt(r[2],16), b: parseInt(r[3],16) } : null;
}

// -- Test-surface exports ---------------------------------------------------
/* istanbul ignore next */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    _isSilentArray,
    livelyAudioListener,
    _renderSpectrum,
    _freqToX,
    setSize,
    _get: function() {
      return { silentFrameCount, micActive, SILENCE_THRESHOLD,
               SILENCE_FRAMES_REQUIRED, peakDirection };
    },
  };
}
