const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 50e6
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));

const rooms = new Map();

app.get('/api/create-room', async (req, res) => {
  const roomId = crypto.randomBytes(4).toString('hex');
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const url = `${protocol}://${host}/mobile.html?room=${roomId}`;
  try {
    const qr = await QRCode.toDataURL(url, {
      width: 280,
      margin: 2,
      color: { dark: '#e8e8e8', light: '#1a1a2e' }
    });
    rooms.set(roomId, { created: Date.now(), devices: 0 });
    res.json({ roomId, qr, url });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join-room', (roomId) => {
    currentRoom = roomId;
    socket.join(roomId);
    const room = rooms.get(roomId);
    if (room) {
      room.devices++;
      socket.to(roomId).emit('device-joined', { devices: room.devices });
    } else {
      rooms.set(roomId, { created: Date.now(), devices: 1 });
    }
    socket.emit('room-joined', { roomId });
  });

  socket.on('colors-update', ({ roomId, colors }) => {
    socket.to(roomId).emit('colors-update', colors);
  });

  socket.on('image-update', ({ roomId, image, name }) => {
    socket.to(roomId).emit('image-update', { image, name });
  });

  socket.on('submit-job', ({ roomId, job }) => {
    socket.to(roomId).emit('new-job', job);
  });

  socket.on('job-complete', ({ roomId, jobId, result }) => {
    socket.to(roomId).emit('job-complete', { jobId, result });
  });

  socket.on('disconnect', () => {
    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) {
        room.devices--;
        socket.to(currentRoom).emit('device-left', { devices: room.devices });
        if (room.devices <= 0) rooms.delete(currentRoom);
      }
    }
  });
});

setInterval(() => {
  const cutoff = Date.now() - 3600000;
  for (const [id, room] of rooms) {
    if (room.created < cutoff && room.devices <= 0) rooms.delete(id);
  }
}, 600000);

function rgbToColorName(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / (2 * 255);
  const range = max - min;
  const s = range === 0 ? 0 : range / (l > 0.5 ? (510 - max - min) : (max + min));

  if (l < 0.1) return 'black';
  if (l > 0.9 && s < 0.1) return 'white';
  if (s < 0.08) {
    if (l < 0.35) return 'dark gray';
    if (l < 0.65) return 'gray';
    return 'light gray';
  }

  let h;
  if (range === 0) h = 0;
  else if (max === r) h = ((g - b) / range + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / range + 2) * 60;
  else h = ((r - g) / range + 4) * 60;

  let name;
  if (h < 15 || h >= 345) name = 'red';
  else if (h < 45) name = 'orange';
  else if (h < 70) name = 'yellow';
  else if (h < 160) name = 'green';
  else if (h < 200) name = 'teal';
  else if (h < 260) name = 'blue';
  else if (h < 300) name = 'purple';
  else name = 'pink';

  if (l < 0.3) return 'dark ' + name;
  if (l > 0.7) return 'light ' + name;
  return name;
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

app.get('/api/ai-status', (req, res) => {
  const provider = process.env.OPENAI_API_KEY ? 'openai' : process.env.REPLICATE_API_TOKEN ? 'replicate' : null;
  res.json({ available: !!provider, provider });
});

// ---- SKIN DETECTION ----
function isSkinPixel(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const v = max / 255;
  const s = max === 0 ? 0 : d / max;
  let h;
  if (d === 0) h = 0;
  else if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;

  return (h <= 50 || h >= 340) && s >= 0.08 && s <= 0.80 && v >= 0.15 && v <= 0.95
    && r > 50 && g > 20 && r >= g;
}

// ---- OPENAI RECOLOR ----
function buildRecolorPrompt(colors) {
  const colorDescs = colors.map(c => {
    const hex = rgbToHex(c[0], c[1], c[2]);
    const name = rgbToColorName(c[0], c[1], c[2]);
    return { hex, name };
  });

  if (colorDescs.length === 1) {
    return `Recolor all fabric areas of the clothing/garment in this image to exactly ${colorDescs[0].name} (hex ${colorDescs[0].hex}). The output color must precisely match this hex code. Preserve the exact garment shape, seams, fabric texture, folds, wrinkles, shadows, and lighting. Do not change the background, skin, hair, or any non-clothing element.`;
  } else if (colorDescs.length === 2) {
    return `Recolor the clothing/garment in this image using exactly two colors. Look at the original image and identify which areas are the DOMINANT fabric color and which areas are a DIFFERENT contrasting color. Change the dominant fabric areas to exactly ${colorDescs[0].name} (hex ${colorDescs[0].hex}). Change ONLY the areas that already have a visibly different contrasting color to exactly ${colorDescs[1].name} (hex ${colorDescs[1].hex}). Do NOT spread the second color to areas that matched the dominant color in the original. Preserve the exact same color zone distribution as the original. Keep garment shape, seams, fabric texture, and lighting identical. Do not change the background, skin, or hair.`;
  }
  return `Recolor the clothing/garment using exactly three colors. Identify the original image's color zones: dominant fabric, secondary contrasting sections, and small accent details. Change the dominant fabric to exactly ${colorDescs[0].name} (hex ${colorDescs[0].hex}), secondary contrasting sections to exactly ${colorDescs[1].name} (hex ${colorDescs[1].hex}), and small accent details to exactly ${colorDescs[2].name} (hex ${colorDescs[2].hex}). Do NOT spread any color to areas that did not have a distinct color in the original. Preserve the exact same color zone distribution. Keep garment shape, texture, lighting identical. Do not change background, skin, or hair.`;
}

function extractOpenAIResult(response) {
  const resultData = response.data[0];
  if (resultData.b64_json) {
    return Buffer.from(resultData.b64_json, 'base64');
  }
  return null;
}

// ---- COLOR CORRECTION ----
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1/3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1/3) * 255)
  ];
}

function colorDistance(r1, g1, b1, r2, g2, b2) {
  return Math.sqrt((r1-r2)**2 + (g1-g2)**2 + (b1-b2)**2);
}

async function correctColors(originalBuffer, resultBuffer, targetColors) {
  const sharp = require('sharp');

  const origMeta = await sharp(originalBuffer).metadata();
  const resMeta = await sharp(resultBuffer).metadata();

  const w = resMeta.width;
  const h = resMeta.height;

  const origPixels = await sharp(originalBuffer)
    .resize(w, h)
    .removeAlpha()
    .raw()
    .toBuffer();

  const resPixels = await sharp(resultBuffer)
    .removeAlpha()
    .raw()
    .toBuffer();

  const output = Buffer.from(resPixels);
  const threshold = 30;

  const targetHsls = targetColors.map(c => rgbToHsl(c[0], c[1], c[2]));

  for (let i = 0; i < w * h; i++) {
    const idx = i * 3;
    const oR = origPixels[idx], oG = origPixels[idx+1], oB = origPixels[idx+2];
    const rR = resPixels[idx], rG = resPixels[idx+1], rB = resPixels[idx+2];

    const dist = colorDistance(oR, oG, oB, rR, rG, rB);

    if (dist > threshold) {
      const [rH, rS, rL] = rgbToHsl(rR, rG, rB);

      if (targetColors.length === 1) {
        const [tH, tS] = targetHsls[0];
        const [nR, nG, nB] = hslToRgb(tH, tS, rL);
        output[idx] = nR; output[idx+1] = nG; output[idx+2] = nB;
      } else {
        let bestIdx = 0;
        let bestDist = Infinity;
        for (let t = 0; t < targetHsls.length; t++) {
          const [tH, tS, tL] = targetHsls[t];
          const hueDiff = Math.min(Math.abs(rH - tH), 1 - Math.abs(rH - tH));
          const satDiff = Math.abs(rS - tS);
          const d = hueDiff * 2 + satDiff;
          if (d < bestDist) { bestDist = d; bestIdx = t; }
        }
        const [tH, tS] = targetHsls[bestIdx];
        const [nR, nG, nB] = hslToRgb(tH, tS, rL);
        output[idx] = nR; output[idx+1] = nG; output[idx+2] = nB;
      }
    }
  }

  return sharp(output, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toBuffer();
}

async function recolorWithSkinRemoval(openai, originalBuffer, prompt, aiQuality, targetColors) {
  const sharp = require('sharp');
  const OpenAI = require('openai');

  const meta = await sharp(originalBuffer).metadata();
  const origW = meta.width;
  const origH = meta.height;
  const GRAY = { r: 180, g: 180, b: 180 };

  const paddedRaw = await sharp(originalBuffer)
    .resize(1024, 1024, { fit: 'contain', background: GRAY })
    .removeAlpha()
    .raw()
    .toBuffer();

  const safePixels = Buffer.from(paddedRaw);
  const total = 1024 * 1024;
  const skinMask = new Uint8Array(total);

  for (let i = 0; i < total; i++) {
    const idx = i * 3;
    if (isSkinPixel(safePixels[idx], safePixels[idx + 1], safePixels[idx + 2])) {
      skinMask[i] = 1;
      safePixels[idx] = GRAY.r;
      safePixels[idx + 1] = GRAY.g;
      safePixels[idx + 2] = GRAY.b;
    }
  }

  const safePng = await sharp(safePixels, { raw: { width: 1024, height: 1024, channels: 3 } })
    .png()
    .toBuffer();

  const imageFile = await OpenAI.toFile(safePng, 'garment.png', { type: 'image/png' });
  const response = await openai.images.edit({
    model: 'gpt-image-1',
    image: imageFile,
    prompt,
    quality: aiQuality,
    size: '1024x1024',
  });

  const resultBuf = extractOpenAIResult(response);
  if (!resultBuf) {
    const rd = response.data[0];
    if (rd.url) {
      const resp = await fetch(rd.url);
      const buf = Buffer.from(await resp.arrayBuffer());
      return 'data:image/png;base64,' + buf.toString('base64');
    }
    throw new Error('No image in OpenAI response');
  }

  const resultPixels = await sharp(resultBuf)
    .resize(1024, 1024)
    .removeAlpha()
    .raw()
    .toBuffer();

  const composite = Buffer.alloc(total * 3);
  for (let i = 0; i < total; i++) {
    const idx = i * 3;
    if (skinMask[i]) {
      composite[idx] = paddedRaw[idx];
      composite[idx + 1] = paddedRaw[idx + 1];
      composite[idx + 2] = paddedRaw[idx + 2];
    } else {
      composite[idx] = resultPixels[idx];
      composite[idx + 1] = resultPixels[idx + 1];
      composite[idx + 2] = resultPixels[idx + 2];
    }
  }

  const scale = Math.min(1024 / origW, 1024 / origH);
  const scaledW = Math.round(origW * scale);
  const scaledH = Math.round(origH * scale);
  const left = Math.round((1024 - scaledW) / 2);
  const top = Math.round((1024 - scaledH) / 2);

  let finalBuf = await sharp(composite, { raw: { width: 1024, height: 1024, channels: 3 } })
    .extract({ left, top, width: scaledW, height: scaledH })
    .resize(origW, origH)
    .png()
    .toBuffer();

  if (targetColors && targetColors.length > 0) {
    console.log('Applying color correction (skin removal path)...');
    finalBuf = await correctColors(originalBuffer, finalBuf, targetColors);
  }

  return 'data:image/png;base64,' + finalBuf.toString('base64');
}

async function recolorWithOpenAI(image, colors, quality) {
  const OpenAI = require('openai');
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const aiQuality = ['low', 'medium', 'high'].includes(quality) ? quality : 'medium';

  const mimeMatch = image.match(/^data:(image\/\w+);base64,/);
  const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
  const ext = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png';
  const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(base64Data, 'base64');

  const prompt = buildRecolorPrompt(colors);
  console.log('OpenAI prompt:', prompt);

  const imageFile = await OpenAI.toFile(buffer, `garment.${ext}`, { type: mimeType });

  try {
    const response = await openai.images.edit({
      model: 'gpt-image-1',
      image: imageFile,
      prompt,
      quality: aiQuality,
      size: '1024x1024',
    });
    let resultBuf = extractOpenAIResult(response);
    if (!resultBuf) {
      const rd = response.data[0];
      if (rd.url) {
        const resp = await fetch(rd.url);
        resultBuf = Buffer.from(await resp.arrayBuffer());
      } else {
        throw new Error('No image in OpenAI response');
      }
    }

    console.log('Applying color correction...');
    const corrected = await correctColors(buffer, resultBuf, colors);
    return 'data:image/png;base64,' + corrected.toString('base64');
  } catch (err) {
    console.log('OpenAI error:', err.status, err.message);
    const isSafety = err.status === 400 && err.message && err.message.includes('safety');
    if (!isSafety) throw err;
    console.log('Safety rejection detected — retrying with skin removal...');
    try {
      return await recolorWithSkinRemoval(openai, buffer, prompt, aiQuality, colors);
    } catch (retryErr) {
      console.error('Skin removal retry also failed:', retryErr.message);
      throw new Error('Image was rejected by OpenAI safety filter. Try using a flat-lay or mannequin photo instead of an on-model photo.');
    }
  }
}

// ---- REPLICATE RECOLOR (fallback) ----
async function recolorWithReplicate(image, colors) {
  const Replicate = require('replicate');
  const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

  const colorDescs = colors.map(c => {
    const hex = rgbToHex(c[0], c[1], c[2]);
    const name = rgbToColorName(c[0], c[1], c[2]);
    return `${name} (${hex})`;
  });

  let prompt;
  if (colorDescs.length === 1) {
    prompt = `Change the color of the clothing to ${colorDescs[0]}. Keep the same fabric texture, folds, shadows and lighting. Do not change anything else.`;
  } else if (colorDescs.length === 2) {
    prompt = `Recolor the clothing: make the main body area ${colorDescs[0]} and any secondary elements like trim, waistband, stripes or accents ${colorDescs[1]}. Keep the same fabric texture and lighting.`;
  } else {
    prompt = `Recolor the clothing: dominant area ${colorDescs[0]}, secondary sections ${colorDescs[1]}, small accents ${colorDescs[2]}. Keep fabric texture and lighting.`;
  }

  console.log('Replicate prompt:', prompt);

  const output = await replicate.run(
    'timothybrooks/instruct-pix2pix:30c1d0b916a6f8efce20493f5d61ee27491ab2a60437c13c588468b9810ec23f',
    {
      input: {
        image,
        prompt,
        num_inference_steps: colors.length > 1 ? 40 : 30,
        image_guidance_scale: 1.2,
        guidance_scale: colors.length > 1 ? 11 : 9
      }
    }
  );

  let resultBuffer;
  if (Array.isArray(output) && output.length > 0) {
    const url = typeof output[0] === 'string' ? output[0] : output[0]?.url || String(output[0]);
    const resp = await fetch(url);
    resultBuffer = Buffer.from(await resp.arrayBuffer());
  } else if (typeof output === 'string') {
    const resp = await fetch(output);
    resultBuffer = Buffer.from(await resp.arrayBuffer());
  } else if (output && typeof output[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    for await (const chunk of output) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    resultBuffer = Buffer.concat(chunks);
  } else {
    throw new Error('Unexpected output format from Replicate');
  }

  return 'data:image/png;base64,' + resultBuffer.toString('base64');
}

app.post('/api/recolor', async (req, res) => {
  const { image, colors, quality } = req.body;

  if (!image) return res.status(400).json({ error: 'No image provided' });
  if (!colors || !colors.length) return res.status(400).json({ error: 'No colors provided' });

  try {
    let result;
    if (process.env.OPENAI_API_KEY) {
      console.log('Using OpenAI for recoloring');
      result = await recolorWithOpenAI(image, colors, quality);
    } else if (process.env.REPLICATE_API_TOKEN) {
      console.log('Using Replicate for recoloring');
      result = await recolorWithReplicate(image, colors);
    } else {
      return res.status(400).json({ error: 'No AI provider configured' });
    }

    res.json({ result });
  } catch (err) {
    console.error('Recolor error:', err.message);
    console.error('Stack:', err.stack);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.send('ok'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Color Changer running on port ${PORT}`);
});
