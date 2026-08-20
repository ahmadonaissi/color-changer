const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const crypto = require('crypto');
const path = require('path');

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

app.get('/api/ai-status', (req, res) => {
  res.json({ available: !!process.env.REPLICATE_API_TOKEN });
});

app.post('/api/segment', async (req, res) => {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) return res.status(400).json({ error: 'AI not configured' });

  try {
    const Replicate = require('replicate');
    const replicate = new Replicate({ auth: token });
    const { image } = req.body;

    const output = await replicate.run(
      'cjwbw/rembg:fb8af171cfa1616ddcf1242c093f9c46bcada5ad4cf6f2fbe8b81b330ec5c003',
      { input: { image } }
    );

    const maskUrl = typeof output === 'string' ? output : output?.url || output;
    const maskResp = await fetch(maskUrl);
    const maskBuffer = Buffer.from(await maskResp.arrayBuffer());
    const maskBase64 = 'data:image/png;base64,' + maskBuffer.toString('base64');

    res.json({ mask: maskBase64 });
  } catch (err) {
    console.error('Segmentation error:', err);
    res.status(500).json({ error: 'Segmentation failed: ' + err.message });
  }
});

app.get('/health', (req, res) => res.send('ok'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Color Changer running on port ${PORT}`);
});
