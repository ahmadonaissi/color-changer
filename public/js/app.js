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
  let activeJobId = null;
  let imageReady = false;
  let aiAvailable = false;
  let saveDirHandle = null;

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const colorLabels = ['Primary', 'Secondary', 'Accent'];

  function toast(msg, ms = 3000) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('visible');
    setTimeout(() => t.classList.remove('visible'), ms);
  }

  // ---- CHECK AI ----
  fetch('/api/ai-status').then(r => r.json()).then(data => {
    aiAvailable = data.available;
    if (aiAvailable) {
      toast('AI garment detection enabled', 2000);
    }
  }).catch(() => {});

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
      updateHint();
      $('#receivedColorsSection').style.display = scannedColors.length > 0 ? '' : 'none';
    });
    socket.on('image-update', ({ image, name }) => {
      loadImageFromDataUrl(image, (img) => {
        currentImage = img;
        currentImageSrc = image;
        showPreview(image);
        if (name) $('#pieceName').value = name;
        updateHint();
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
        enqueueJob(job.name, job.image, job.colors, []);
        resetWorkspace();
      });
    });
  }

  // ---- CAMERA ----
  let cameraActive = false;
  $('#toggleCameraBtn').addEventListener('click', async () => {
    if (cameraActive) stopCamera(); else await startCamera();
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
    if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
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
      updateHint();
      crosshair.style.left = e.clientX - container.getBoundingClientRect().left + 'px';
      crosshair.style.top = e.clientY - container.getBoundingClientRect().top + 'px';
      crosshair.style.borderColor = `rgb(${color.join(',')})`;
      crosshair.classList.add('active');
      setTimeout(() => crosshair.classList.remove('active'), 800);
      if (socket && mode === 'paired') socket.emit('colors-update', { roomId, colors: scannedColors });
    });
  }

  // ---- MANUAL COLOR ----
  $('#addManualColor').addEventListener('click', () => {
    if (scannedColors.length >= 3) { toast('Max 3 colors. Remove one first.'); return; }
    const hex = $('#manualColorPicker').value;
    scannedColors.push([parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]);
    renderColorSlots();
    updateHint();
  });

  // ---- COLOR SLOTS ----
  function renderColorSlots() {
    $$('#pickedColors .color-slot, #pairedColors .color-slot').forEach((slot) => {
      const idx = parseInt(slot.dataset.index);
      const label = slot.querySelector('.label');
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
      if (label) label.textContent = colorLabels[idx];
    });
  }

  document.addEventListener('click', (e) => {
    if (e.target.classList.contains('remove')) {
      const slot = e.target.closest('.color-slot');
      const idx = parseInt(slot.dataset.index);
      if (idx < scannedColors.length) {
        scannedColors.splice(idx, 1);
        renderColorSlots();
        updateHint();
        clearMarkers();
        if (socket && mode === 'paired') socket.emit('colors-update', { roomId, colors: scannedColors });
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
    e.preventDefault(); uploadArea.style.borderColor = '';
    if (e.dataTransfer.files.length) handleImageFile(e.dataTransfer.files[0]);
  });
  imageInput.addEventListener('change', (e) => { if (e.target.files.length) handleImageFile(e.target.files[0]); });

  $('#changeImageBtn').addEventListener('click', () => imageInput.click());

  $('#removeImageBtn').addEventListener('click', () => {
    currentImage = null;
    currentImageSrc = null;
    imageReady = false;
    clearMarkers();
    $('#previewImage').style.display = 'none';
    uploadArea.classList.remove('has-image');
    uploadArea.querySelector('.upload-icon').style.display = '';
    uploadArea.querySelector('p').style.display = '';
    $('#changeImageBar').style.display = 'none';
    imageInput.value = '';
    toast('Image removed');
  });

  function handleImageFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      currentImageSrc = e.target.result;
      showPreview(currentImageSrc);
      loadImageFromDataUrl(currentImageSrc, (img) => {
        currentImage = img;
        imageReady = true;
        clearMarkers();
        updateHint();
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

  // ---- MARKER SYSTEM (fallback when AI not available) ----
  markerOverlay.addEventListener('click', (e) => {
    if (aiAvailable) return;
    e.stopPropagation();
    if (!imageReady || scannedColors.length === 0) return;
    if (markerPoints.length >= scannedColors.length) { toast('All colors assigned. Clear markers to redo.'); return; }
    const rect = markerOverlay.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    const relY = (e.clientY - rect.top) / rect.height;
    markerPoints.push({ x: relX * currentImage.naturalWidth, y: relY * currentImage.naturalHeight });
    const dot = document.createElement('div');
    dot.className = 'marker-dot';
    dot.style.left = (relX * 100) + '%';
    dot.style.top = (relY * 100) + '%';
    dot.style.background = `rgb(${scannedColors[markerPoints.length - 1].join(',')})`;
    dot.textContent = markerPoints.length;
    markerOverlay.appendChild(dot);
    toast(`${colorLabels[markerPoints.length - 1]} color placed`);
    updateHint();
  });

  function clearMarkers() {
    markerPoints = [];
    markerOverlay.querySelectorAll('.marker-dot').forEach(d => d.remove());
    updateHint();
  }

  function updateHint() {
    const hint = $('#markerHint');
    const overlay = markerOverlay;
    if (!imageReady || scannedColors.length === 0) {
      hint.classList.remove('visible');
      overlay.classList.remove('active');
      return;
    }
    if (aiAvailable) {
      hint.textContent = 'AI will auto-detect the garment';
      hint.classList.add('visible');
      overlay.classList.remove('active');
      setTimeout(() => hint.classList.remove('visible'), 2500);
      return;
    }
    overlay.classList.add('active');
    if (markerPoints.length < scannedColors.length) {
      hint.textContent = `Tap garment for ${colorLabels[markerPoints.length]} (${markerPoints.length + 1}/${scannedColors.length})`;
      hint.classList.add('visible');
    } else {
      hint.textContent = 'All set! Hit Recolor';
      hint.classList.add('visible');
      setTimeout(() => hint.classList.remove('visible'), 2000);
    }
  }

  // ---- RESIZE FOR API ----
  function resizeForApi(img, maxDim) {
    let w = img.naturalWidth, h = img.naturalHeight;
    if (Math.max(w, h) > maxDim) {
      const s = maxDim / Math.max(w, h);
      w = Math.round(w * s);
      h = Math.round(h * s);
    }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.85);
  }

  // ---- RECOLOR BUTTON WITH VALIDATION ----
  $('#processBtn').addEventListener('click', () => {
    if (!imageReady && scannedColors.length === 0) {
      toast('Please upload an image and scan at least one color');
      return;
    }
    if (!imageReady) {
      toast('Please upload an image first');
      return;
    }
    if (scannedColors.length === 0) {
      toast('Please scan at least one color first');
      return;
    }
    if (!aiAvailable && markerPoints.length < scannedColors.length) {
      toast('Please tap on the garment to place all color markers');
      return;
    }

    const name = $('#pieceName').value.trim() || `Piece ${queue.length + 1}`;
    enqueueJob(name, currentImageSrc, [...scannedColors], [...markerPoints]);
    resetWorkspace();
  });

  function resetWorkspace() {
    scannedColors = [];
    currentImage = null;
    currentImageSrc = null;
    imageReady = false;
    clearMarkers();
    renderColorSlots();
    $('#previewImage').style.display = 'none';
    uploadArea.classList.remove('has-image');
    uploadArea.querySelector('.upload-icon').style.display = '';
    uploadArea.querySelector('p').style.display = '';
    $('#pieceName').value = '';
    $('#changeImageBar').style.display = 'none';
    $('#receivedColorsSection').style.display = 'none';
    $('#markerHint').classList.remove('visible');
    imageInput.value = '';
    if (socket && mode === 'paired') socket.emit('colors-update', { roomId, colors: [] });
  }

  function enqueueJob(name, imageSrc, colors, markers) {
    const job = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name, imageSrc, colors, markers,
      status: 'pending', result: null, enhanced: false
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
      let result;

      if (aiAvailable) {
        setProgress(0.05);
        toast('Sending image to AI...', 10000);

        const smallImage = resizeForApi(img, 1024);
        setProgress(0.1);

        const resp = await fetch('/api/segment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: smallImage })
        });

        if (!resp.ok) {
          const errData = await resp.json().catch(() => ({}));
          throw new Error(errData.error || 'AI segmentation failed (status ' + resp.status + ')');
        }

        const { mask } = await resp.json();
        setProgress(0.4);
        toast('Recoloring garment...', 5000);

        const maskImg = await loadImage(mask);
        const maskCanvas = document.createElement('canvas');
        maskCanvas.width = canvas.width;
        maskCanvas.height = canvas.height;
        maskCanvas.getContext('2d').drawImage(maskImg, 0, 0, canvas.width, canvas.height);

        result = await engine.recolorWithMask(canvas, maskCanvas, job.colors, (p) => setProgress(0.4 + p * 0.6));
      } else {
        const scaleX = canvas.width / img.naturalWidth;
        const scaleY = canvas.height / img.naturalHeight;
        const scaledMarkers = job.markers.map(m => ({ x: m.x * scaleX, y: m.y * scaleY }));
        result = await engine.recolor(canvas, job.colors, scaledMarkers, (p) => setProgress(p));
      }

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
      job.errorMsg = err.message;
      console.error('Processing error:', err);
      displayError(job);
      renderQueue();
      toast('Error: ' + err.message, 6000);
    }

    processing = false;
    showProgress(false);
    processNext();
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = src;
    });
  }

  function imageToCanvas(img, maxDim) {
    let w = img.naturalWidth, h = img.naturalHeight;
    if (Math.max(w, h) > maxDim) { const s = maxDim / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return c;
  }

  function showProgress(on) { $('#progressBar').classList.toggle('active', on); if (!on) setProgress(0); }
  function setProgress(p) { $('#progressFill').style.width = Math.round(p * 100) + '%'; }

  // ---- DISPLAY RESULT ----
  function displayResult(job) {
    const container = $('#resultContainer');
    container.classList.add('visible');
    $('#resultTitle').textContent = 'Result — ' + job.name;
    const rc = $('#resultCanvas');
    rc.width = job.result.width; rc.height = job.result.height;
    rc.getContext('2d').drawImage(job.result, 0, 0);
    const info = $('#regionInfo');
    info.innerHTML = '';
    if (job.regions) {
      job.regions.forEach((r) => {
        if (!r.targetColor) return;
        const chip = document.createElement('div');
        chip.className = 'region-chip';
        chip.innerHTML = `<span class="swatch" style="background:rgb(${r.originalColor.join(',')})"></span>
          <span>&#8594;</span>
          <span class="swatch" style="background:rgb(${r.targetColor.join(',')})"></span>
          <span>${r.percentage}%</span>`;
        info.appendChild(chip);
      });
    }
    activeJobId = job.id;
    $('#enhanceBtn').style.display = '';
    $('#downloadBtn').style.display = '';
    $('#saveFolderBtn').style.display = '';
    container.scrollIntoView({ behavior: 'smooth', block: 'center' });
    renderQueue();
  }

  function displayError(job) {
    const container = $('#resultContainer');
    container.classList.add('visible');
    $('#resultTitle').textContent = 'Error — ' + job.name;
    const rc = $('#resultCanvas');
    loadImage(job.imageSrc).then(img => {
      const c = imageToCanvas(img, 800);
      rc.width = c.width; rc.height = c.height;
      rc.getContext('2d').drawImage(c, 0, 0);
    });
    const info = $('#regionInfo');
    info.innerHTML = `<div class="region-chip" style="background:var(--error);color:white;padding:10px 16px">
      ${job.errorMsg || 'Processing failed. Try a different image.'}
    </div>`;
    activeJobId = job.id;
    $('#enhanceBtn').style.display = 'none';
    $('#downloadBtn').style.display = 'none';
    $('#saveFolderBtn').style.display = 'none';
    container.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
            ${job.colors.map(c => {
              const hex = '#' + c.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
              return `<span class="dot" style="background:rgb(${c.join(',')})"></span><span class="hex">${hex}</span>`;
            }).join('')}
          </div>
        </div>
      </div>`).join('');
    list.querySelectorAll('.queue-item').forEach(el => {
      el.addEventListener('click', () => {
        const job = queue.find(j => j.id === el.dataset.id);
        if (job && job.status === 'complete') displayResult(job);
        if (job && job.status === 'error') displayError(job);
      });
    });
  }

  // ---- NEW PIECE ----
  $('#newPieceBtn').addEventListener('click', () => {
    $('#resultContainer').classList.remove('visible');
    uploadArea.scrollIntoView({ behavior: 'smooth' });
  });

  // ---- ENHANCE ----
  $('#enhanceBtn').addEventListener('click', () => {
    const job = queue.find(j => j.id === activeJobId);
    if (!job || !job.result) return;
    if (job.enhanced) { toast('Already enhanced'); return; }
    toast('Enhancing...');
    setTimeout(() => {
      job.result = engine.enhance(job.result);
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
        const w = await handle.createWritable(); await w.write(blob); await w.close();
        toast('Saved!');
      } catch (err) { if (err.name !== 'AbortError') toast('Save failed: ' + err.message); }
    } else {
      const link = document.createElement('a');
      link.download = `${safeName}.png`; link.href = URL.createObjectURL(blob);
      link.click(); URL.revokeObjectURL(link.href); toast('Downloaded!');
    }
  });

  // ---- CREATE FOLDER ----
  $('#saveFolderBtn').addEventListener('click', () => {
    const job = queue.find(j => j.id === activeJobId);
    if (!job) return;
    if (!('showDirectoryPicker' in window)) { toast('Folder save requires Chrome on desktop.'); return; }
    $('#folderNameInput').value = job.name;
    if (saveDirHandle) {
      $('#locationLabel').textContent = 'Location: ' + saveDirHandle.name;
      $('#locationLabel').style.display = '';
      $('#confirmSave').disabled = false;
    } else {
      $('#locationLabel').style.display = 'none';
      $('#confirmSave').disabled = true;
    }
    $('#saveModal').classList.add('visible');
  });
  $('#pickLocationBtn').addEventListener('click', async () => {
    try {
      saveDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      $('#locationLabel').textContent = 'Location: ' + saveDirHandle.name;
      $('#locationLabel').style.display = '';
      $('#confirmSave').disabled = false;
    } catch (err) { if (err.name !== 'AbortError') toast('Could not pick location'); }
  });
  $('#cancelSave').addEventListener('click', () => { $('#saveModal').classList.remove('visible'); });
  $('#confirmSave').addEventListener('click', async () => {
    const job = queue.find(j => j.id === activeJobId);
    if (!job || !job.result || !saveDirHandle) return;
    const folderName = ($('#folderNameInput').value.trim() || job.name).replace(/[^a-zA-Z0-9 _-]/g, '');
    $('#saveModal').classList.remove('visible');
    try {
      const subDir = await saveDirHandle.getDirectoryHandle(folderName, { create: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const fileName = `${folderName}_${ts}.png`;
      const fh = await subDir.getFileHandle(fileName, { create: true });
      const w = await fh.createWritable();
      await w.write(await new Promise(r => job.result.toBlob(r, 'image/png')));
      await w.close();
      toast(`Saved to ${saveDirHandle.name}/${folderName}/${fileName}`);
    } catch (err) { if (err.name !== 'AbortError') toast('Save failed: ' + err.message); }
  });
})();
