/* Offline render worker for the Transform tab. Keeps the heavy phase-vocoder
   / vocoder math off the UI thread. */
importScripts("./transformer-dsp.js");

self.onmessage = function (e) {
  const msg = e.data || {};
  if (msg.type !== "render") return;
  const { channels, sr, stages } = msg;
  try {
    const D = self.TransformerDSP;
    const out = D.runChain(channels, sr, stages, (frac, label) => {
      self.postMessage({ type: "progress", frac, label });
    });
    D.normalizePeak(out, 0.99);
    const transfer = out.map((c) => c.buffer);
    self.postMessage({ type: "done", channels: out, sr }, transfer);
  } catch (err) {
    self.postMessage({ type: "error", message: String((err && err.message) || err) });
  }
};
