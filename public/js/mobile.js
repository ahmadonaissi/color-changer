(function () {
  const params = new URLSearchParams(location.search);
  const roomId = params.get('room');
  let socket = null;
  let cameraStream = null;
  let scannedColors = [];
  let imageDataUrl = null;

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  function toast(msg, ms = 3000) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('visible');
    setTimeout(() => t.classList.remove('visible'), ms);
  }

  // ---- CONNECT ----
  if (!roomId) {
    toast('No room code. Scan the QR code from the laptop.', 5000);
  } else {
    socket = io();
    socket.on('connect', () => {
      socket.emit('join-room', roomId);
    });
    socket.on('room-joined', () => {
      $('#connBadge').textContent = 'Connected';
      $('#connBadge').classList.add('connected');
      toast('Connected to laptop!');
    });
    socket.on('device-left', () => {
      $('#connBadge').textContent = 'Disconnected';
      $('#connBadge').classList.remove('connected');
    });
    socket.on('job-complete', ({ jobId, result }) => {
      toast('Image recolored! Check laptop.');
    });
    socket.on('colors-update', (colors) => {
      scannedColors = colors;
      renderSlots();
      updateSubmitBtn();
    });
  }

  // ---- CAMERA ----
  async function startCamera() {
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } }
      });
      const video = $('#mobileVideo');
      video.srcObject = cameraStream;
      await video.play();
      const overlay = $('#mobileOverlay');
      overlay.width = video.videoWidth;
      overlay.height = video.videoHeight;
      setupPicking(video, overlay);
    } catch (err) {
      toast('Camera not available');
    }
  }

  function setupPicking(video, overlay) {
    const ctx = overlay.getContext('2d', { willReadFrequently: true });

    function draw() {
      if (!cameraStream) return;
      ctx.drawImage(video, 0, 0, overlay.width, overlay.height);
      requestAnimationFrame(draw);
    }
    draw();

    overlay.addEventListener('click', (e) => {
      if (scannedColors.length >= 3) {
        toast('Max 3 colors. Tap a color circle to remove.');
        return;
      }
      const rect = overlay.getBoundingClientRect();
      const sx = overlay.width / rect.width;
      const sy = overlay.height / rect.height;
      const x = Math.round((e.clientX - rect.left) * sx);
      const y = Math.round((e.clientY - rect.top) * sy);

      const size = 5;
      const pixel = ctx.getImageData(Math.max(0, x - size), Math.max(0, y - size), size * 2, size * 2);
      let rr = 0, gg = 0, bb = 0, count = 0;
      for (let i = 0; i < pixel.data.length; i += 4) {
        rr += pixel.data[i]; gg += pixel.data[i + 1]; bb += pixel.data[i + 2];
        count++;
      }
      const color = [Math.round(rr / count), Math.round(gg / count), Math.round(bb / count)];
      scannedColors.push(color);
      renderSlots();
      updateSubmitBtn();

      if (socket) {
        socket.emit('colors-update', { roomId, colors: scannedColors });
      }

      const labels = ['Primary', 'Secondary', 'Accent'];
      toast(`${labels[scannedColors.length - 1]} color picked`);
    });
  }

  startCamera();

  // ---- COLOR SLOTS ----
  function renderSlots() {
    $$('#mobileColors .color-slot').forEach((slot) => {
      const idx = parseInt(slot.dataset.index);
      if (idx < scannedColors.length) {
        const c = scannedColors[idx];
        slot.style.background = `rgb(${c.join(',')})`;
        slot.classList.add('filled');
        slot.querySelector('span').textContent = '';
      } else {
        slot.style.background = '';
        slot.classList.remove('filled');
        slot.querySelector('span').textContent = idx + 1;
      }
    });
  }

  document.addEventListener('click', (e) => {
    if (e.target.classList.contains('remove')) {
      const slot = e.target.closest('.color-slot');
      const idx = parseInt(slot.dataset.index);
      if (idx < scannedColors.length) {
        scannedColors.splice(idx, 1);
        renderSlots();
        updateSubmitBtn();
        if (socket) socket.emit('colors-update', { roomId, colors: scannedColors });
      }
    }
  });

  // ---- IMAGE ----
  const fileInput = $('#mobileImageInput');
  $('#mobileUploadBtn').addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', (e) => {
    if (!e.target.files.length) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      imageDataUrl = ev.target.result;
      const preview = $('#mobilePreview');
      $('#mobilePreviewImg').src = imageDataUrl;
      preview.classList.add('visible');
      updateSubmitBtn();
      toast('Image loaded');

      if (socket && roomId) {
        const name = $('#mobilePieceName').value.trim() || '';
        socket.emit('image-update', { roomId, image: imageDataUrl, name });
        toast('Image sent to laptop');
      }
    };
    reader.readAsDataURL(e.target.files[0]);
  });

  function updateSubmitBtn() {
    $('#mobileSubmitBtn').disabled = !(scannedColors.length > 0 && imageDataUrl);
  }

  // ---- SUBMIT ----
  $('#mobileSubmitBtn').addEventListener('click', () => {
    if (!imageDataUrl || scannedColors.length === 0) return;
    if (!socket || !roomId) {
      toast('Not connected to laptop');
      return;
    }

    const name = $('#mobilePieceName').value.trim() || `Piece ${Date.now().toString(36).slice(-4)}`;

    socket.emit('submit-job', {
      roomId,
      job: {
        name,
        image: imageDataUrl,
        colors: [...scannedColors]
      }
    });

    toast('Submitted! Check the laptop for results.');

    // Reset for next piece
    imageDataUrl = null;
    scannedColors = [];
    renderSlots();
    $('#mobilePreview').classList.remove('visible');
    $('#mobilePieceName').value = '';
    updateSubmitBtn();
  });
})();
