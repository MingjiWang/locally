/* ---------------------------------------------------------------
   liquid.js  –  vanilla-JS liquid glass with SVG displacement
   Port of liquid-lib.ts (refraction profile + displacement map)
   --------------------------------------------------------------- */

(function () {
  const NS = "http://www.w3.org/2000/svg";
  const isChromium = /Chrome|Edg|Opera/.test(navigator.userAgent) && !/Firefox/.test(navigator.userAgent);
  // Safari & Firefox have shaky backdrop-filter:url() support; only enable on Chromium.
  const SUPPORTED = isChromium;

  // ---------- Bezel surface profiles ----------
  const SURFACE = {
    convex: (x) => Math.pow(1 - Math.pow(1 - x, 4), 1 / 4),
    convexCircle: (x) => Math.sqrt(1 - (1 - x) * (1 - x)),
    lip: (x) => {
      const cv = Math.pow(1 - Math.pow(1 - x * 2, 4), 1 / 4) || 0;
      const cc = 1 - Math.sqrt(1 - (1 - x) * (1 - x)) + 0.1;
      const s = 6 * x * x * x * x * x - 15 * x * x * x * x + 10 * x * x * x;
      return cv * (1 - s) + cc * s;
    },
  };

  // ---------- Refraction math (Snell) ----------
  function refractionProfile(glassThickness, bezelWidth, bezelFn, refractiveIndex, samples) {
    const eta = 1 / refractiveIndex;
    function refract(nx, ny) {
      const dot = ny;
      const k = 1 - eta * eta * (1 - dot * dot);
      if (k < 0) return null;
      const kS = Math.sqrt(k);
      return [-(eta * dot + kS) * nx, eta - (eta * dot + kS) * ny];
    }
    const out = new Array(samples);
    for (let i = 0; i < samples; i++) {
      const x = i / samples;
      const y = bezelFn(x);
      const dx = x < 1 ? 0.0001 : -0.0001;
      const der = (bezelFn(x + dx) - y) / dx;
      const mag = Math.sqrt(der * der + 1);
      const nx = -der / mag;
      const ny = -1 / mag;
      const r = refract(nx, ny);
      if (!r) {
        out[i] = 0;
      } else {
        const remHOnBezel = y * bezelWidth;
        const remH = remHOnBezel + glassThickness;
        out[i] = r[0] * (remH / r[1]);
      }
    }
    return out;
  }

  // ---------- Displacement texture (RG = x/y displacement) ----------
  function buildDisplacementCanvas(w, h, radius, bezel, profile, maxDisp, dpr) {
    const W = Math.max(1, Math.round(w * dpr));
    const H = Math.max(1, Math.round(h * dpr));
    const cv = document.createElement("canvas");
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext("2d");
    const img = ctx.createImageData(W, H);
    const data = img.data;

    // Neutral fill: R=G=128 (no displacement), B=0, A=255
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 128; data[i + 1] = 128; data[i + 2] = 0; data[i + 3] = 255;
    }

    const r = radius * dpr;
    const b = bezel * dpr;
    const rSq = r * r;
    const rPlusSq = (r + 1) * (r + 1);
    const rMinusSq = (r - b) * (r - b);
    const wBetween = W - r * 2;
    const hBetween = H - r * 2;

    for (let y1 = 0; y1 < H; y1++) {
      for (let x1 = 0; x1 < W; x1++) {
        const idx = (y1 * W + x1) * 4;

        const onLeft = x1 < r;
        const onRight = x1 >= W - r;
        const onTop = y1 < r;
        const onBottom = y1 >= H - r;

        const x = onLeft ? x1 - r : (onRight ? x1 - r - wBetween : 0);
        const y = onTop ? y1 - r : (onBottom ? y1 - r - hBetween : 0);

        const distSq = x * x + y * y;
        const inBezel = distSq <= rPlusSq && distSq >= rMinusSq;

        if (inBezel) {
          const distFromCenter = Math.sqrt(distSq);
          const opacity =
            distSq < rSq
              ? 1
              : 1 - (distFromCenter - Math.sqrt(rSq)) / (Math.sqrt(rPlusSq) - Math.sqrt(rSq));
          const distFromSide = r - distFromCenter;
          const cos = distFromCenter ? x / distFromCenter : 0;
          const sin = distFromCenter ? y / distFromCenter : 0;
          const bIdx = Math.max(0, Math.min(profile.length - 1, ((distFromSide / b) * profile.length) | 0));
          const d = profile[bIdx] || 0;
          const denom = maxDisp || 1;
          const dX = (-cos * d) / denom;
          const dY = (-sin * d) / denom;
          data[idx] = 128 + dX * 127 * opacity;
          data[idx + 1] = 128 + dY * 127 * opacity;
          data[idx + 2] = 0;
          data[idx + 3] = 255;
        }
      }
    }

    ctx.putImageData(img, 0, 0);
    return cv.toDataURL();
  }

  // ---------- Specular highlight overlay (the wet "lit edge") ----------
  function buildSpecularCanvas(w, h, radius, bezel, dpr, angle = Math.PI / 3) {
    const W = Math.max(1, Math.round(w * dpr));
    const H = Math.max(1, Math.round(h * dpr));
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d");
    const img = ctx.createImageData(W, H);
    const data = img.data;
    const r = radius * dpr;
    const b = bezel * dpr;
    const rSq = r * r;
    const rPlusSq = (r + dpr) * (r + dpr);
    const rMinusSq = (r - b) * (r - b);
    const wBetween = W - r * 2;
    const hBetween = H - r * 2;
    const sv = [Math.cos(angle), Math.sin(angle)];

    for (let y1 = 0; y1 < H; y1++) {
      for (let x1 = 0; x1 < W; x1++) {
        const idx = (y1 * W + x1) * 4;
        const onLeft = x1 < r;
        const onRight = x1 >= W - r;
        const onTop = y1 < r;
        const onBottom = y1 >= H - r;
        const x = onLeft ? x1 - r : (onRight ? x1 - r - wBetween : 0);
        const y = onTop ? y1 - r : (onBottom ? y1 - r - hBetween : 0);
        const distSq = x * x + y * y;
        if (distSq <= rPlusSq && distSq >= rMinusSq) {
          const distFromCenter = Math.sqrt(distSq);
          const distFromSide = r - distFromCenter;
          const opacity = distSq < rSq ? 1 : 1 - (distFromCenter - Math.sqrt(rSq)) / (Math.sqrt(rPlusSq) - Math.sqrt(rSq));
          const cos = distFromCenter ? x / distFromCenter : 0;
          const sin = distFromCenter ? -y / distFromCenter : 0;
          const dot = Math.abs(cos * sv[0] + sin * sv[1]);
          const coef = dot * Math.sqrt(Math.max(0, 1 - Math.pow(1 - distFromSide / dpr, 2)));
          const c = 255 * coef;
          const a = c * coef * opacity;
          data[idx] = c; data[idx + 1] = c; data[idx + 2] = c; data[idx + 3] = a;
        } else {
          data[idx + 3] = 0;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    return cv.toDataURL();
  }

  // ---------- Apply liquid glass to one element ----------
  let _idCounter = 0;
  function _nextId() { return "lg-" + (++_idCounter); }

  function applyLiquidGlass(el, opts) {
    if (!el || el.dataset.lgApplied === "1") return;
    if (!SUPPORTED) {
      // Fallback: keep CSS backdrop-filter blur from modern.css
      return;
    }

    const cfg = Object.assign({
      glassThickness: 200,
      bezelWidth: 36,
      refractiveIndex: 1.6,
      samples: 128,
      bezelFn: SURFACE.convex,
      blur: 0.5,
      saturation: 4,
      specularOpacity: 1,
      addSpecularLayer: true,
    }, opts || {});

    const filterId = _nextId();
    const ns = NS;

    // SVG container (one per element so it can resize independently)
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.style.position = "absolute";
    svg.style.left = "0";
    svg.style.top = "0";
    svg.style.width = "0";
    svg.style.height = "0";
    svg.style.overflow = "visible";
    svg.style.pointerEvents = "none";
    svg.setAttribute("color-interpolation-filters", "sRGB");
    document.body.appendChild(svg);

    const defs = document.createElementNS(ns, "defs");
    svg.appendChild(defs);

    const filter = document.createElementNS(ns, "filter");
    filter.setAttribute("id", filterId);
    filter.setAttribute("x", "0");
    filter.setAttribute("y", "0");
    filter.setAttribute("width", "100");
    filter.setAttribute("height", "100");
    filter.setAttribute("filterUnits", "userSpaceOnUse");
    filter.setAttribute("color-interpolation-filters", "sRGB");
    defs.appendChild(filter);

    const blurNode = document.createElementNS(ns, "feGaussianBlur");
    blurNode.setAttribute("in", "SourceGraphic");
    blurNode.setAttribute("stdDeviation", String(cfg.blur));
    blurNode.setAttribute("result", "blurred");
    filter.appendChild(blurNode);

    const dispImg = document.createElementNS(ns, "feImage");
    dispImg.setAttribute("x", "0");
    dispImg.setAttribute("y", "0");
    dispImg.setAttribute("width", "100");
    dispImg.setAttribute("height", "100");
    dispImg.setAttribute("preserveAspectRatio", "none");
    dispImg.setAttribute("result", "displacement");
    filter.appendChild(dispImg);

    const dispMap = document.createElementNS(ns, "feDisplacementMap");
    dispMap.setAttribute("in", "blurred");
    dispMap.setAttribute("in2", "displacement");
    dispMap.setAttribute("xChannelSelector", "R");
    dispMap.setAttribute("yChannelSelector", "G");
    dispMap.setAttribute("scale", "0");
    dispMap.setAttribute("result", "displaced");
    filter.appendChild(dispMap);

    const sat = document.createElementNS(ns, "feColorMatrix");
    sat.setAttribute("in", "displaced");
    sat.setAttribute("type", "saturate");
    sat.setAttribute("values", String(cfg.saturation));
    sat.setAttribute("result", "displaced_sat");
    filter.appendChild(sat);

    let specImg, specComp, specFade;
    if (cfg.addSpecularLayer) {
      specImg = document.createElementNS(ns, "feImage");
      specImg.setAttribute("x", "0");
      specImg.setAttribute("y", "0");
      specImg.setAttribute("width", "100");
      specImg.setAttribute("height", "100");
      specImg.setAttribute("preserveAspectRatio", "none");
      specImg.setAttribute("result", "specular");
      filter.appendChild(specImg);

      specComp = document.createElementNS(ns, "feComposite");
      specComp.setAttribute("in", "displaced_sat");
      specComp.setAttribute("in2", "specular");
      specComp.setAttribute("operator", "in");
      specComp.setAttribute("result", "spec_in_sat");
      filter.appendChild(specComp);

      specFade = document.createElementNS(ns, "feComponentTransfer");
      specFade.setAttribute("in", "specular");
      specFade.setAttribute("result", "spec_faded");
      const slope = document.createElementNS(ns, "feFuncA");
      slope.setAttribute("type", "linear");
      slope.setAttribute("slope", String(cfg.specularOpacity));
      specFade.appendChild(slope);
      filter.appendChild(specFade);

      const blend1 = document.createElementNS(ns, "feBlend");
      blend1.setAttribute("in", "spec_in_sat");
      blend1.setAttribute("in2", "displaced");
      blend1.setAttribute("mode", "normal");
      blend1.setAttribute("result", "withSat");
      filter.appendChild(blend1);

      const blend2 = document.createElementNS(ns, "feBlend");
      blend2.setAttribute("in", "spec_faded");
      blend2.setAttribute("in2", "withSat");
      blend2.setAttribute("mode", "normal");
      filter.appendChild(blend2);
    }

    el.style.backdropFilter = `url(#${filterId})`;
    el.style.webkitBackdropFilter = `url(#${filterId})`;
    el.dataset.lgApplied = "1";

    function update() {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) return;
      const cs = getComputedStyle(el);
      let radiusRaw = parseFloat(cs.borderRadius);
      if (!isFinite(radiusRaw) || radiusRaw < 0) radiusRaw = 0;
      // rounded-pill (very large radius) -> half min-side
      if (radiusRaw > 9999 || /e\+/i.test(cs.borderRadius)) {
        radiusRaw = Math.min(rect.width, rect.height) / 2;
      } else {
        radiusRaw = Math.min(radiusRaw, Math.min(rect.width, rect.height) / 2);
      }
      const radius = radiusRaw;
      const bezel = Math.max(1, Math.min(cfg.bezelWidth, radius));

      const dpr = window.devicePixelRatio || 1;
      const profile = refractionProfile(cfg.glassThickness, bezel, cfg.bezelFn, cfg.refractiveIndex, cfg.samples);
      const maxDisp = profile.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

      const dispUrl = buildDisplacementCanvas(rect.width, rect.height, radius, bezel, profile, maxDisp, dpr);

      filter.setAttribute("x", "0");
      filter.setAttribute("y", "0");
      filter.setAttribute("width", String(rect.width));
      filter.setAttribute("height", String(rect.height));

      dispImg.setAttribute("href", dispUrl);
      dispImg.setAttributeNS("http://www.w3.org/1999/xlink", "href", dispUrl);
      dispImg.setAttribute("width", String(rect.width));
      dispImg.setAttribute("height", String(rect.height));

      dispMap.setAttribute("scale", String(maxDisp));

      if (cfg.addSpecularLayer && specImg) {
        const specUrl = buildSpecularCanvas(rect.width, rect.height, radius, bezel, dpr);
        specImg.setAttribute("href", specUrl);
        specImg.setAttributeNS("http://www.w3.org/1999/xlink", "href", specUrl);
        specImg.setAttribute("width", String(rect.width));
        specImg.setAttribute("height", String(rect.height));
      }
    }

    // Observe size changes
    const ro = new ResizeObserver(() => requestAnimationFrame(update));
    ro.observe(el);
    requestAnimationFrame(update);
  }

  // ---------- Auto-apply via CSS selectors ----------
  function autoApply() {
    if (!SUPPORTED) return;
    const targets = [
      // Big surfaces – heavy refraction at the rounded corners
      { sel: ".lg-card", opts: { bezelWidth: 40, glassThickness: 240, refractiveIndex: 1.65, blur: 0.6 } },
      { sel: ".lg-pill", opts: { bezelWidth: 28, glassThickness: 180, refractiveIndex: 1.6, blur: 0.5, saturation: 4 } },
      // Buttons get strong refraction at their pill ends
      { sel: ".lg-button", opts: { bezelWidth: 22, glassThickness: 140, refractiveIndex: 1.6, blur: 0.5 } },
      { sel: "button:not(.lg-skip)", opts: { bezelWidth: 20, glassThickness: 130, refractiveIndex: 1.55, blur: 0.5 } },
      // Drop zones / log boxes / metric cards
      { sel: ".drop-zone", opts: { bezelWidth: 32, glassThickness: 200, refractiveIndex: 1.6, blur: 0.6 } },
      { sel: "#log", opts: { bezelWidth: 30, glassThickness: 180, refractiveIndex: 1.55, blur: 0.7 } },
      { sel: ".metric, .meter-block, .helpbox", opts: { bezelWidth: 24, glassThickness: 150, refractiveIndex: 1.55, blur: 0.5 } },
    ];
    for (const t of targets) {
      document.querySelectorAll(t.sel).forEach((el) => applyLiquidGlass(el, t.opts));
    }
  }

  window.LiquidGlass = {
    apply: applyLiquidGlass,
    autoApply,
    supported: SUPPORTED,
    SURFACE,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoApply);
  } else {
    autoApply();
  }
})();
