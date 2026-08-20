(function () {
  const engine = new ColorEngine();
  let socket = null;
  let roomId = null;
  let mode = 'solo';
  let cameraStream = null;
  let scannedColors = [];
  let currentImage = null;
  let currentImageSrc = null;
  let markerPoints = [];
  let queue = [];
  let processing = false;
  let baseDirHandle = null;
  let activeJobId = null;
  let imageReady = false;

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  function toast(msg, ms = 3000) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('visible');
    setTimeout(() => t.classList.remove('visible'), ms);
  }

  const colorLabels = ['Primary', 'Secondary', 'Accent'];

  // ---- MODE SWITCHING ----
  $$('.mode-tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.mode-tabs button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      mode = btn.dataset.mode;
      if (mode === 'paired') {
        $('#pairSection').style.display = '';
        $('#scanSection').style.display = 'none';
        initPairing();
      } else {
        $('#pairSection').style.display = 'none';
        $('#scanSection').style.display = '';
      }
    });
  });

  // ---- PAIRING ----
  function initPairing() {
    if (socket) socket.disconnect();
    socket = io();
    fetch('/api/create-room').then(r => r.json()).then(data => {
      roomId = data.roomId;
      $('#qrCode').src = data.qr;
      socket.emit('join-room', roomId);
    });

    socket.on('device-joined', () => {
      $('#connDot').classList.add('connected');
      $('#connLabel').textContent = 'Phone connected';
      toast('Phone connected!');
    });

    socket.on('device-left', () => {
      $('#connDot').classList.remove('connected');
      $('#connLabel').textContent = 'Phone disconnected';
    });

    socket.on('colors-update', (colors) => {
      scannedColors = colors;
      renderColorSlots();
      updateMarkerHint();
      updateProcessBtn();
      $('#receivedColorsSection').style.display = scannedColors.length > 0 ? '' : 'none';
    });

    socket.on('image-update', ({ image, name }) => {
      loadImageFromDataUrl(image, (img) => {
        currentImage = img;
        currentImageSrc = image;
        showPreview(image);
        if (name) $('#pieceName').value = name;
        updateMarkerHint();
        updateProcessBtn();
        toast('Image received from phone');
      });
    });

    socket.on('new-job', (job) => {
      loadImageFromDataUrl(job.image, (img) => {
        scannedColors = job.colors;
        renderColorSlots();
        currentImage = img;
        currentImageSrc = job.image;
        showPreview(job.image);
        $('#pieceName').value = job.name || '';
        addToQueue(job.name, job.image, job.colors, job.markers || []);
      });
    });
  }

  // ---- CAMERA ----
  let cameraActive = false;

  $('#toggleCameraBtn').addEventListener('click', async () => {
    if (cameraActive) stopCamera();
    else await startCamera();
  });

  async function startCamera() {
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } }
      });
      const video = $('#cameraVideo');
      video.srcObject = cameraStream;
      await video.play();
      const canvas = $('#cameraCanvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      cameraActive = true;
      $('#toggleCameraBtn').textContent = 'Stop Camera';
      setupColorPicking(video, canvas, $('#crosshair'), $('#cameraBox'));
    } catch (err) {
      toast('Camera not available. Use the manual color picker.');
    }
  }

  function stopCamera() {
    if (cameraStream) {
      cameraStream.getTracks().forEach(t => t.stop());
      cameraStream = null;
    }
    cameraActive = false;
    $('#toggleCameraBtn').textContent = 'Start Camera';
  }

  function setupColorPicking(video, canvas, crosshair, container) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    function drawFrame() {
      if (!cameraActive) return;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      requestAnimationFrame(drawFrame);
    }
    drawFrame();

    canvas.addEventListener('click', (e) => {
      if (scannedColors.length >= 3) { toast('Max 3 colors. Remove one first.'); return; }
      const rect = canvas.getBoundingClientRect();
      const x = Math.round((e.clientX - rect.left) * (canvas.width / rect.width));
      const y = Math.round((e.clientY - rect.top) * (canvas.height / rect.height));
      const size = 5;
      const pixel = ctx.getImageData(Math.max(0, x - size), Math.max(0, y - size), size * 2, size * 2);
      let rr = 0, gg = 0, bb = 0, count = 0;
      for (let i = 0; i < pixel.data.length; i += 4) {
        rr += pixel.data[i]; gg += pixel.data[i + 1]; bb += pixel.data[i + 2]; count++;
      }
      const color = [Math.round(rr / count), Math.round(gg / count), Math.round(bb / count)];
      scannedColors.push(color);
      renderColorSlots();
      updateMarkerHint();
      updateProcessBtn();
      crosshair.style.left = e.clientX - container.getBoundingClientRect().left + 'px';
      crosshair.style.top = e.clientY - container.getBoundingClientRect().top + 'px';
      crosshair.style.borderColor = `rgb(${color.join(',')})`;
      crosshair.classList.add('active');
      setTimeout(() => crosshair.classList.remove('active'), 800);
      if (socket && mode === 'paired') {
        socket.emit('colors-update', { roomId, colors: scannedColors });
      }
    });
  }

  // ---- MANUAL COLOR ----
  $('#addManualColor').addEventListener('click', () => {
    if (scannedColors.length >= 3) { toast('Max 3 colors. Remove one first.'); return; }
    const hex = $('#manualColorPicker').value;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    scannedColors.push([r, g, b]);
    renderColorSlots();
    updateMarkerHint();
    updateProcessBtn();
  });

  // ---- COLOR SLOTS ----
  function renderColorSlots() {
    const slots = $$('#pickedColors .color-slot, #pairedColors .color-slot, #mobileColors .color-slot');
    slots.forEach((slot) => {
      const idx = parseInt(slot.dataset.index);
      const label = slot.querySelector('.label');
      if (idx < scannedColors.length) {
        const c = scannedColors[idx];
        slot.style.background = `rgb(${c.join(',')})`;
        slot.classList.add('filled');
        slot.querySelector('span').textContent = '';
        if (label) label.textContent = colorLabels[idx];
      } else {
        slot.style.background = '';
        slot.classList.remove('filled');
        slot.querySelector('span').textContent = idx + 1;
        if (label) label.textContent = colorLabels[idx];
      }
    });
  }

  document.addEventListener('click', (e) => {
    if (e.target.classList.contains('remove')) {
      const slot = e.target.closest('.color-slot');
      const idx = parseInt(slot.dataset.index);
      if (idx < scannedColors.length) {
        scannedColors.splice(idx, 1);
        renderColorSlots();
        updateMarkerHint();
        updateProcessBtn();
        clearMarkers();
      }
    }
  });

  // ---- IMAGE UPLOAD ----
  const uploadArea = $('#uploadArea');
  const imageInput = $('#imageInput');
  const markerOverlay = $('#markerOverlay');

  uploadArea.addEventListener('click', (e) => {
    if (e.target === markerOverlay || e.target.classList.contains('marker-dot')) return;
    if (!imageReady) imageInput.click();
  });
  uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.style.borderColor = 'var(--accent)'; });
  uploadArea.addEventListener('dragleave', () => { uploadArea.style.borderColor = ''; });
  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.style.borderColor = '';
    if (e.dataTransfer.files.length) handleImageFile(e.dataTransfer.files[0]);
  });
  imageInput.addEventListener('change', (e) => {
    if (e.target.files.length) handleImageFile(e.target.files[0]);
  });

  $('#changeImageBtn').addEventListener('click', () => imageInput.click());
  $('#clearMarkersBtn').addEventListener('click', clearMarkers);

  function handleImageFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      currentImageSrc = e.target.result;
      showPreview(currentImageSrc);
      loadImageFromDataUrl(currentImageSrc, (img) => {
        currentImage = img;
        imageReady = true;
        clearMarkers();
        updateMarkerHint();
        updateProcessBtn();
        $('#changeImageBar').style.display = '';
      });
    };
    reader.readAsDataURL(file);
  }

  function showPreview(dataUrl) {
    const img = $('#previewImage');
    img.src = dataUrl;
    img.style.display = '';
    imageReady = true;
    uploadArea.classList.add('has-image');
    uploadArea.querySelector('.upload-icon').style.display = 'none';
    uploadArea.querySelector('p').style.display = 'none';
    $('#changeImageBar').style.display = '';
  }

  function loadImageFromDataUrl(dataUrl, cb) {
    const img = new Image();
    img.onload = () => cb(img);
    img.src = dataUrl;
  }

  // ---- MARKER SYSTEM ----
  markerOverlay.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!imageReady || scannedColors.length === 0) return;
    if (markerPoints.length >= scannedColors.length) {
      toast('All colors assigned. Clear markers to redo.');
      return;
    }

    const rect = markerOverlay.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    const relY = (e.clientY - rect.top) / rect.height;
    const imgX = relX * currentImage.naturalWidth;
    const imgY = relY * currentImage.naturalHeight;

    const colorIdx = markerPoints.length;
    markerPoints.push({ x: imgX, y: imgY });

    const dot = document.createElement('div');
    dot.className = 'marker-dot';
    dot.style.left = (relX * 100) + '%';
    dot.style.top = (relY * 100) + '%';
    dot.style.background = `rgb(${scannedColors[colorIdx].join(',')})`;
    dot.textContent = colorIdx + 1;
    markerOverlay.appendChild(dot);

    toast(`${colorLabels[colorIdx]} color placed on garment`);
    updateMarkerHint();
    updateProcessBtn();
  });

  function clearMarkers() {
    markerPoints = [];
    markerOverlay.querySelectorAll('.marker-dot').forEach(d => d.remove());
    updateMarkerHint();
    updateProcessBtn();
  }

  function updateMarkerHint() {
    const hint = $('#markerHint');
    const overlay = markerOverlay;

    if (!imageReady || scannedColors.length === 0) {
      hint.classList.remove('visible');
      overlay.classList.remove('active');
      return;
    }

    overlay.classList.add('active');

    if (markerPoints.length < scannedColors.length) {
      const next = colorLabels[markerPoints.length];
      hint.textContent = `Tap on the garment for ${next} color (${markerPoints.length + 1}/${scannedColors.length})`;
      hint.classList.add('visible');
    } else {
      hint.textContent = 'All set! Hit Recolor';
      hint.classList.add('visible');
      setTimeout(() => hint.classList.remove('visible'), 2000);
    }
  }

  function updateProcessBtn() {
    const ready = scannedColors.length > 0 && imageReady && markerPoints.length >= scannedColors.length;
    $('#processBtn').disabled = !ready;
  }

  // ---- PROCESSING ----
  $('#processBtn').addEventListener('click', () => {
    if (!currentImage || scannedColors.length === 0 || markerPoints.length < scannedColors.length) return;
    const name = $('#pieceName').value.trim() || `Piece ${queue.length + 1}`;
    addToQueue(name, currentImageSrc, [...scannedColors], [...markerPoints]);

    scannedColors = [];
    currentImage = null;
    currentImageSrc = null;
    imageReady = false;
    clearMarkers();
    renderColorSlots();
    updateProcessBtn();
    $('#previewImage').style.display = 'none';
    uploadArea.classList.remove('has-image');
    uploadArea.querySelector('.upload-icon').style.display = '';
    uploadArea.querySelector('p').style.display = '';
    $('#pieceName').value = '';
    $('#changeImageBar').style.display = 'none';
    $('#receivedColorsSection').style.display = 'none';
    imageInput.value = '';

    if (socket && mode === 'paired') {
      socket.emit('colors-update', { roomId, colors: [] });
    }
  });

  function addToQueue(name, imageSrc, colors, markers) {
    const job = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name,
      imageSrc,
      colors,
      markers,
      status: 'pending',
      result: null,
      enhanced: false
    };
    queue.push(job);
    renderQueue();
    processNext();
  }

  async function processNext() {
    if (processing) return;
    const job = queue.find(j => j.status === 'pending');
    if (!job) return;

    processing = true;
    job.status = 'processing';
    activeJobId = job.id;
    renderQueue();
    showProgress(true);

    try {
      const img = await loadImage(job.imageSrc);
      const canvas = imageToCanvas(img, 1500);

      const scaleX = canvas.width / img.naturalWidth;
      const scaleY = canvas.height / img.naturalHeight;
      const scaledMarkers = job.markers.map(m => ({
        x: m.x * scaleX,
        y: m.y * scaleY
      }));

      const result = await engine.recolor(canvas, job.colors, scaledMarkers, (p) => {
        setProgress(p);
      });

      job.result = result.canvas;
      job.regions = result.regions;
      job.status = 'complete';

      displayResult(job);
      renderQueue();
      toast(`"${job.name}" is ready!`);

      if (socket && mode === 'paired') {
        socket.emit('job-complete', { roomId, jobId: job.id, result: result.canvas.toDataURL('image/png') });
      }
    } catch (err) {
      job.status = 'error';
      toast('Error processing image: ' + err.message);
      renderQueue();
    }

    processing = false;
    showProgress(false);
    processNext();
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function imageToCanvas(img, maxDim) {
    let w = img.naturalWidth, h = img.naturalHeight;
    if (Math.max(w, h) > maxDim) {
      const scale = maxDim / Math.max(w, h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return c;
  }

  // ---- PROGRESS ----
  function showProgress(on) {
    $('#progressBar').classList.toggle('active', on);
    if (!on) setProgress(0);
  }
  function setProgress(p) {
    $('#progressFill').style.width = Math.round(p * 100) + '%';
  }

  // ---- DISPLAY RESULT ----
  function displayResult(job) {
    const container = $('#resultContainer');
    container.classList.add('visible');
    const rc = $('#resultCanvas');
    rc.width = job.result.width;
    rc.height = job.result.height;
    rc.getContext('2d').drawImage(job.result, 0, 0);

    const info = $('#regionInfo');
    info.innerHTML = '';
    if (job.regions) {
      job.regions.forEach((r) => {
        if (!r.targetColor) return;
        const chip = document.createElement('div');
        chip.className = 'region-chip';
        chip.innerHTML = `
          <span class="swatch" style="background:rgb(${r.originalColor.join(',')})"></span>
          <span>&#8594;</span>
          <span class="swatch" style="background:rgb(${r.targetColor.join(',')})"></span>
          <span>${r.percentage}%</span>
        `;
        info.appendChild(chip);
      });
    }
    activeJobId = job.id;
    renderQueue();
  }

  // ---- QUEUE ----
  function renderQueue() {
    const list = $('#queueList');
    if (queue.length === 0) {
      list.innerHTML = '<div class="queue-empty">No items yet. Scan colors and submit an image to start.</div>';
      return;
    }
    list.innerHTML = queue.map(job => `
      <div class="queue-item ${job.id === activeJobId ? 'active' : ''}" data-id="${job.id}">
        <div class="queue-thumb"><img src="${job.imageSrc}" alt=""></div>
        <div class="queue-info">
          <span class="name">${job.name}</span>
          <span class="status ${job.status}">
            ${job.status === 'processing' ? '<span class="spinner"></span>' : ''}
            ${job.status === 'pending' ? 'Waiting...' : ''}
            ${job.status === 'processing' ? 'Processing...' : ''}
            ${job.status === 'complete' ? 'Done' : ''}
            ${job.status === 'error' ? 'Error' : ''}
          </span>
          <div class="queue-colors">
            ${job.colors.map(c => `<span class="dot" style="background:rgb(${c.join(',')})"></span>`).join('')}
          </div>
        </div>
      </div>
    `).join('');
    list.querySelectorAll('.queue-item').forEach(el => {
      el.addEventListener('click', () => {
        const job = queue.find(j => j.id === el.dataset.id);
        if (job && job.status === 'complete') displayResult(job);
      });
    });
  }

  // ---- NEW PIECE ----
  $('#newPieceBtn').addEventListener('click', () => {
    $('#resultContainer').classList.remove('visible');
    uploadArea.scrollIntoView({ behavior: 'smooth' });
    imageInput.click();
  });

  // ---- ENHANCE ----
  $('#enhanceBtn').addEventListener('click', () => {
    const job = queue.find(j => j.id === activeJobId);
    if (!job || !job.result) return;
    if (job.enhanced) { toast('Already enhanced'); return; }
    toast('Enhancing...');
    setTimeout(() => {
      const enhanced = engine.enhance(job.result);
      job.result = enhanced;
      job.enhanced = true;
      displayResult(job);
      toast('Quality enhanced (2x upscale + sharpening)');
    }, 50);
  });

  // ---- DOWNLOAD ----
  $('#downloadBtn').addEventListener('click', async () => {
    const job = queue.find(j => j.id === activeJobId);
    if (!job || !job.result) return;
    const safeName = job.name.replace(/[^a-zA-Z0-9 _-]/g, '') || 'image';
    const blob = await new Promise(r => job.result.toBlob(r, 'image/png'));
    if ('showSaveFilePicker' in window) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: `${safeName}.png`,
          types: [{ description: 'PNG Image', accept: { 'image/png': ['.png'] } }]
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        toast('Saved!');
      } catch (err) {
        if (err.name !== 'AbortError') toast('Save failed: ' + err.message);
      }
    } else {
      const link = document.createElement('a');
      link.download = `${safeName}.png`;
      link.href = URL.createObjectURL(blob);
      link.click();
      URL.revokeObjectURL(link.href);
      toast('Downloaded!');
    }
  });

  // ---- CREATE FOLDER ----
  $('#saveFolderBtn').addEventListener('click', () => {
    const job = queue.find(j => j.id === activeJobId);
    if (!job) return;
    $('#folderNameInput').value = job.name;
    $('#saveModal').classList.add('visible');
  });
  $('#cancelSave').addEventListener('click', () => { $('#saveModal').classList.remove('visible'); });
  $('#confirmSave').addEventListener('click', async () => {
    const job = queue.find(j => j.id === activeJobId);
    if (!job || !job.result) return;
    const folderName = ($('#folderNameInput').value.trim() || job.name).replace(/[^a-zA-Z0-9 _-]/g, '');
    $('#saveModal').classList.remove('visible');
    if ('showDirectoryPicker' in window) {
      try {
        if (!baseDirHandle) {
          baseDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
          toast('Base folder set. Future saves go here automatically.');
        }
        const subDir = await baseDirHandle.getDirectoryHandle(folderName, { create: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const fileName = `${folderName}_${timestamp}.png`;
        const fileHandle = await subDir.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        const blob = await new Promise(r => job.result.toBlob(r, 'image/png'));
        await writable.write(blob);
        await writable.close();
        toast(`Saved to ${folderName}/${fileName}`);
      } catch (err) {
        if (err.name !== 'AbortError') toast('Save failed: ' + err.message);
      }
    } else {
      toast('Folder save requires Chrome on desktop. Use Download instead.');
    }
  });
})();
