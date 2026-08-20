class ColorEngine {
  rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;
    if (max === min) {
      h = s = 0;
    } else {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
        case g: h = ((b - r) / d + 2) / 6; break;
        case b: h = ((r - g) / d + 4) / 6; break;
      }
    }
    return [h * 360, s * 100, l * 100];
  }

  hslToRgb(h, s, l) {
    h /= 360; s /= 100; l /= 100;
    if (s === 0) {
      const v = Math.round(l * 255);
      return [v, v, v];
    }
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [
      Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
      Math.round(hue2rgb(p, q, h) * 255),
      Math.round(hue2rgb(p, q, h - 1 / 3) * 255)
    ];
  }

  colorDistSq(c1, c2) {
    const dr = c1[0] - c2[0], dg = c1[1] - c2[1], db = c1[2] - c2[2];
    return dr * dr + dg * dg + db * db;
  }

  kMeansPP(pixels, k) {
    const centroids = [pixels[Math.floor(Math.random() * pixels.length)].slice()];
    for (let i = 1; i < k; i++) {
      const dists = pixels.map(p => Math.min(...centroids.map(c => this.colorDistSq(p, c))));
      const total = dists.reduce((a, b) => a + b, 0);
      let r = Math.random() * total;
      for (let j = 0; j < pixels.length; j++) {
        r -= dists[j];
        if (r <= 0) { centroids.push(pixels[j].slice()); break; }
      }
      if (centroids.length <= i) centroids.push(pixels[Math.floor(Math.random() * pixels.length)].slice());
    }
    return centroids;
  }

  kMeans(pixels, k, maxIter = 25) {
    let centroids = this.kMeansPP(pixels, k);
    const assignments = new Int32Array(pixels.length);

    for (let iter = 0; iter < maxIter; iter++) {
      let changed = false;
      for (let i = 0; i < pixels.length; i++) {
        let minD = Infinity, minJ = 0;
        for (let j = 0; j < k; j++) {
          const d = this.colorDistSq(pixels[i], centroids[j]);
          if (d < minD) { minD = d; minJ = j; }
        }
        if (assignments[i] !== minJ) { assignments[i] = minJ; changed = true; }
      }
      if (!changed) break;

      const sums = Array.from({ length: k }, () => [0, 0, 0]);
      const counts = new Int32Array(k);
      for (let i = 0; i < pixels.length; i++) {
        const j = assignments[i];
        sums[j][0] += pixels[i][0];
        sums[j][1] += pixels[i][1];
        sums[j][2] += pixels[i][2];
        counts[j]++;
      }
      for (let j = 0; j < k; j++) {
        if (counts[j] > 0) {
          centroids[j] = [sums[j][0] / counts[j], sums[j][1] / counts[j], sums[j][2] / counts[j]];
        }
      }
    }
    return { centroids, assignments };
  }

  detectBackground(width, height, centroids, pixelClusters, k) {
    const votes = new Int32Array(k);
    const margin = 3;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (x < margin || x >= width - margin || y < margin || y >= height - margin) {
          votes[pixelClusters[y * width + x]]++;
        }
      }
    }
    let maxV = 0, bg = 0;
    for (let i = 0; i < k; i++) {
      if (votes[i] > maxV) { maxV = votes[i]; bg = i; }
    }
    const totalBorder = 2 * (width + height - 4) * margin;
    if (maxV < totalBorder * 0.15) return -1;
    return bg;
  }

  isSkin(r, g, b) {
    const [h, s, l] = this.rgbToHsl(r, g, b);
    return h >= 0 && h <= 50 && s >= 15 && s <= 75 && l >= 20 && l <= 78;
  }

  async recolorWithMask(sourceCanvas, maskCanvas, targetColors, onProgress) {
    const w = sourceCanvas.width, h = sourceCanvas.height;
    const srcCtx = sourceCanvas.getContext('2d');
    const srcData = srcCtx.getImageData(0, 0, w, h);
    const sd = srcData.data;

    const maskScaled = document.createElement('canvas');
    maskScaled.width = w; maskScaled.height = h;
    const mCtx = maskScaled.getContext('2d');
    mCtx.drawImage(maskCanvas, 0, 0, w, h);
    const maskData = mCtx.getImageData(0, 0, w, h);
    const md = maskData.data;

    const totalPixels = w * h;
    const garmentPixels = [];
    const garmentIndices = [];

    for (let i = 0; i < totalPixels; i++) {
      const idx = i * 4;
      if (md[idx + 3] < 128) continue;
      const r = sd[idx], g = sd[idx + 1], b = sd[idx + 2];
      if (this.isSkin(r, g, b)) continue;
      garmentPixels.push([r, g, b]);
      garmentIndices.push(i);
    }

    if (onProgress) onProgress(0.3);

    const sampleSize = Math.min(8000, garmentPixels.length);
    const step = Math.max(1, Math.floor(garmentPixels.length / sampleSize));
    const sampled = [];
    for (let i = 0; i < garmentPixels.length; i += step) {
      sampled.push(garmentPixels[i]);
    }

    const k = Math.max(targetColors.length, 2);
    const { centroids } = this.kMeans(sampled, k);

    if (onProgress) onProgress(0.5);

    const clusterAssign = new Int32Array(garmentPixels.length);
    for (let i = 0; i < garmentPixels.length; i++) {
      const p = garmentPixels[i];
      let minD = Infinity, minJ = 0;
      for (let j = 0; j < k; j++) {
        const dr = p[0] - centroids[j][0], dg = p[1] - centroids[j][1], db = p[2] - centroids[j][2];
        if (dr * dr + dg * dg + db * db < minD) { minD = dr * dr + dg * dg + db * db; minJ = j; }
      }
      clusterAssign[i] = minJ;
    }

    const sizes = new Int32Array(k);
    for (let i = 0; i < garmentPixels.length; i++) sizes[clusterAssign[i]]++;

    const sorted = centroids
      .map((c, i) => ({ color: c.map(Math.round), index: i, size: sizes[i] }))
      .sort((a, b) => b.size - a.size);

    const colorMap = new Map();
    const centroidHsl = new Map();
    for (let i = 0; i < Math.min(targetColors.length, sorted.length); i++) {
      const ci = sorted[i].index;
      colorMap.set(ci, targetColors[i]);
      centroidHsl.set(ci, this.rgbToHsl(...sorted[i].color));
    }

    const targetHsls = new Map();
    for (const [ci, tc] of colorMap) targetHsls.set(ci, this.rgbToHsl(...tc));

    if (onProgress) onProgress(0.6);

    const resultCanvas = document.createElement('canvas');
    resultCanvas.width = w; resultCanvas.height = h;
    const rCtx = resultCanvas.getContext('2d');
    rCtx.drawImage(sourceCanvas, 0, 0);
    const resultData = rCtx.getImageData(0, 0, w, h);
    const rd = resultData.data;

    const chunk = 50000;
    for (let start = 0; start < garmentIndices.length; start += chunk) {
      const end = Math.min(start + chunk, garmentIndices.length);
      for (let gi = start; gi < end; gi++) {
        const i = garmentIndices[gi];
        const cluster = clusterAssign[gi];
        if (!colorMap.has(cluster)) continue;

        const idx = i * 4;
        const r = sd[idx], g = sd[idx + 1], b = sd[idx + 2];
        const [ph, ps, pl] = this.rgbToHsl(r, g, b);
        const [th, ts] = targetHsls.get(cluster);
        const [ch, cs] = centroidHsl.get(cluster);

        let newS = cs > 5 ? Math.min(100, ts * (ps / cs)) : ts * 0.6;
        const [nr, ng, nb] = this.hslToRgb(th, newS, pl);
        rd[idx] = nr; rd[idx + 1] = ng; rd[idx + 2] = nb;
      }
      if (onProgress) onProgress(0.6 + 0.35 * (end / garmentIndices.length));
      await new Promise(r => setTimeout(r, 0));
    }

    rCtx.putImageData(resultData, 0, 0);
    if (onProgress) onProgress(1);

    const regions = sorted.slice(0, targetColors.length).map((s, i) => ({
      originalColor: s.color,
      targetColor: targetColors[i] || null,
      size: s.size,
      percentage: Math.round(s.size / totalPixels * 100)
    }));
    return { canvas: resultCanvas, regions };
  }

  async recolor(sourceCanvas, targetColors, markerPoints, onProgress) {
    const ctx = sourceCanvas.getContext('2d');
    const w = sourceCanvas.width, h = sourceCanvas.height;
    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;
    const totalPixels = w * h;

    const sampleSize = Math.min(10000, totalPixels);
    const step = Math.max(1, Math.floor(totalPixels / sampleSize));
    const sampled = [];
    for (let i = 0; i < totalPixels; i += step) {
      const idx = i * 4;
      sampled.push([data[idx], data[idx + 1], data[idx + 2]]);
    }

    const k = Math.max(targetColors.length + 2, 5);
    const { centroids } = this.kMeans(sampled, k);

    if (onProgress) onProgress(0.2);

    const pixelClusters = new Int32Array(totalPixels);
    for (let i = 0; i < totalPixels; i++) {
      const idx = i * 4;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];
      let minD = Infinity, minJ = 0;
      for (let j = 0; j < k; j++) {
        const dr = r - centroids[j][0], dg = g - centroids[j][1], db = b - centroids[j][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < minD) { minD = d; minJ = j; }
      }
      pixelClusters[i] = minJ;
    }

    if (onProgress) onProgress(0.5);

    const colorMap = new Map();
    const centroidHsl = new Map();
    const usedClusters = new Set();

    for (let i = 0; i < markerPoints.length && i < targetColors.length; i++) {
      const mx = Math.min(Math.max(0, Math.round(markerPoints[i].x)), w - 1);
      const my = Math.min(Math.max(0, Math.round(markerPoints[i].y)), h - 1);
      const cluster = pixelClusters[my * w + mx];
      if (!usedClusters.has(cluster)) {
        usedClusters.add(cluster);
        colorMap.set(cluster, targetColors[i]);
        centroidHsl.set(cluster, this.rgbToHsl(...centroids[cluster].map(Math.round)));
      }
    }

    const targetHsls = new Map();
    for (const [ci, tc] of colorMap) {
      targetHsls.set(ci, this.rgbToHsl(...tc));
    }

    if (onProgress) onProgress(0.6);

    const sizes = new Int32Array(k);
    for (let i = 0; i < totalPixels; i++) sizes[pixelClusters[i]]++;

    const resultCanvas = document.createElement('canvas');
    resultCanvas.width = w;
    resultCanvas.height = h;
    const resultCtx = resultCanvas.getContext('2d');
    const resultData = resultCtx.createImageData(w, h);
    const rd = resultData.data;

    const chunk = 80000;
    for (let start = 0; start < totalPixels; start += chunk) {
      const end = Math.min(start + chunk, totalPixels);
      for (let i = start; i < end; i++) {
        const idx = i * 4;
        const cluster = pixelClusters[i];

        if (!colorMap.has(cluster)) {
          rd[idx] = data[idx];
          rd[idx + 1] = data[idx + 1];
          rd[idx + 2] = data[idx + 2];
          rd[idx + 3] = data[idx + 3];
          continue;
        }

        const r = data[idx], g = data[idx + 1], b = data[idx + 2];
        const [ph, ps, pl] = this.rgbToHsl(r, g, b);
        const [th, ts, _] = targetHsls.get(cluster);
        const [ch, cs, cl] = centroidHsl.get(cluster);

        let newS;
        if (cs > 5) {
          newS = Math.min(100, ts * (ps / cs));
        } else {
          newS = ts * 0.6;
        }

        const [nr, ng, nb] = this.hslToRgb(th, newS, pl);
        rd[idx] = nr;
        rd[idx + 1] = ng;
        rd[idx + 2] = nb;
        rd[idx + 3] = data[idx + 3];
      }
      if (onProgress) onProgress(0.6 + 0.35 * (end / totalPixels));
      await new Promise(r => setTimeout(r, 0));
    }

    resultCtx.putImageData(resultData, 0, 0);
    if (onProgress) onProgress(1);

    const regions = [];
    for (const [ci, tc] of colorMap) {
      regions.push({
        originalColor: centroids[ci].map(Math.round),
        targetColor: tc,
        size: sizes[ci],
        percentage: Math.round(sizes[ci] / totalPixels * 100)
      });
    }
    return { canvas: resultCanvas, regions };
  }

  sharpen(canvas, amount = 1.5) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const orig = ctx.getImageData(0, 0, w, h);

    const blur = document.createElement('canvas');
    blur.width = w; blur.height = h;
    const bCtx = blur.getContext('2d');
    bCtx.filter = 'blur(1px)';
    bCtx.drawImage(canvas, 0, 0);
    const blurData = bCtx.getImageData(0, 0, w, h);

    const result = ctx.createImageData(w, h);
    const od = orig.data, bd = blurData.data, rd = result.data;
    for (let i = 0; i < od.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        rd[i + c] = Math.min(255, Math.max(0, Math.round(od[i + c] + (od[i + c] - bd[i + c]) * amount)));
      }
      rd[i + 3] = od[i + 3];
    }
    ctx.putImageData(result, 0, 0);
    return canvas;
  }

  upscale(canvas, factor = 2) {
    const w = canvas.width * factor, h = canvas.height * factor;
    const up = document.createElement('canvas');
    up.width = w; up.height = h;
    const ctx = up.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, w, h);
    return up;
  }

  enhance(canvas) {
    let result = this.upscale(canvas, 2);
    result = this.sharpen(result, 1.2);
    return result;
  }
}

window.ColorEngine = ColorEngine;
