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

// ---- OPENAI RECOLOR ----
async function recolorWithOpenAI(image, colors) {
  const OpenAI = require('openai');
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const mimeMatch = image.match(/^data:(image\/\w+);base64,/);
  const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
  const ext = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png';
  const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(base64Data, 'base64');

  const colorDescs = colors.map(c => {
    const hex = rgbToHex(c[0], c[1], c[2]);
    const name = rgbToColorName(c[0], c[1], c[2]);
    return { hex, name };
  });

  let prompt;
  if (colorDescs.length === 1) {
    prompt = `Change the color of the clothing/garment in this image to exactly ${colorDescs[0].name} (hex ${colorDescs[0].hex}). The output garment color must precisely match hex ${colorDescs[0].hex}. Keep the exact same garment shape, fabric texture, folds, wrinkles, shadows, and lighting. Do not change the background, skin, hair, or anything else in the image.`;
  } else if (colorDescs.length === 2) {
    prompt = `Recolor the clothing/garment in this image: the main body area must be exactly ${colorDescs[0].name} (hex ${colorDescs[0].hex}) and any secondary elements like trim, waistband, stripes, or accents must be exactly ${colorDescs[1].name} (hex ${colorDescs[1].hex}). Colors must precisely match these hex codes. Keep the garment shape, fabric texture, and lighting identical. Do not change the background or anything else.`;
  } else {
    prompt = `Recolor the clothing/garment: dominant area exactly ${colorDescs[0].name} (hex ${colorDescs[0].hex}), secondary sections exactly ${colorDescs[1].name} (hex ${colorDescs[1].hex}), accent details exactly ${colorDescs[2].name} (hex ${colorDescs[2].hex}). Match hex codes precisely. Keep garment shape, texture, lighting identical. Do not change background or anything else.`;
  }

  console.log('OpenAI prompt:', prompt);

  const imageFile = await OpenAI.toFile(buffer, `garment.${ext}`, { type: mimeType });

  const response = await openai.images.edit({
    model: 'gpt-image-1',
    image: imageFile,
    prompt,
    size: '1024x1024',
  });

  const resultData = response.data[0];

  if (resultData.b64_json) {
    return 'data:image/png;base64,' + resultData.b64_json;
  } else if (resultData.url) {
    const resp = await fetch(resultData.url);
    const buf = Buffer.from(await resp.arrayBuffer());
    return 'data:image/png;base64,' + buf.toString('base64');
  }

  throw new Error('No image in OpenAI response');
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
  const { image, colors } = req.body;

  if (!image) return res.status(400).json({ error: 'No image provided' });
  if (!colors || !colors.length) return res.status(400).json({ error: 'No colors provided' });

  try {
    let result;
    if (process.env.OPENAI_API_KEY) {
      console.log('Using OpenAI for recoloring');
      result = await recolorWithOpenAI(image, colors);
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
