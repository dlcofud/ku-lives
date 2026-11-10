/* KU Lives → CPP300 USB virtual COM thermal printing (Chrome/Edge Web Serial). */
(() => {
  'use strict';
  let port = null;
  let printing = false;
  let rendererPromise;
  const DOTS = 576; // 80 mm paper; approximately 72 mm printable width
  const badges = [];

  function report(message, error = false) {
    for (const el of badges) { el.textContent = message; el.style.color = error ? '#b4233c' : ''; }
  }

  function loadRenderer() {
    if (typeof window.html2canvas === 'function') return Promise.resolve(window.html2canvas);
    if (!rendererPromise) rendererPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
      s.onload = () => typeof window.html2canvas === 'function' ? resolve(window.html2canvas) : reject(new Error('이미지 모듈을 읽을 수 없습니다.'));
      s.onerror = () => reject(new Error('이미지 모듈 다운로드 실패. 인터넷을 확인하세요.'));
      document.head.appendChild(s);
    }).catch(error => { rendererPromise = null; throw error; });
    return rendererPromise;
  }

  async function connect() {
    if (!navigator.serial) {
      report('USB 직접 인쇄는 Windows Chrome/Edge에서 지원됩니다.', true);
      alert('Chrome 또는 Edge에서 HTTPS 사이트를 열어 주세요.');
      return;
    }
    if (port) { report('USB 프린터 연결됨'); return; }
    try {
      // requestPort must be called directly by a user-initiated click.
      const candidate = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x1cbe, usbProductId: 0x0002 }] });
      await candidate.open({ baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
      try { await candidate.setSignals({ dataTerminalReady: true, requestToSend: true }); } catch (_) {}
      port = candidate;
      document.querySelectorAll('.ku-serial-connect').forEach(b => b.textContent = 'USB 연결됨');
      report('USB 프린터 연결됨 · 선택한 장치가 CPP300인지 확인');
    } catch (error) { report('USB 연결 실패: ' + error.message, true); }
  }

  async function snapshot(receipt) {
    const html2canvas = await loadRenderer();
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;top:0;left:-10000px;width:330px;background:white;pointer-events:none';
    const node = receipt.cloneNode(true);
    node.classList.remove('printing');
    node.removeAttribute('id');
    node.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
    node.style.cssText += ';width:330px;max-width:none;margin:0;background:#fff;color:#000;box-shadow:none;animation:none;mask:none;-webkit-mask:none';
    node.querySelectorAll('.small,.stamps i').forEach(el => el.style.color = '#000');
    holder.append(node);
    document.body.append(holder);
    try {
      await document.fonts.ready;
      return await html2canvas(node, {
        backgroundColor: '#ffffff', scale: DOTS / 330,
        width: 330, useCORS: true, logging: false, scrollY: -window.scrollY
      });
    } finally { holder.remove(); }
  }

  function blackPixels(canvas) {
    const { width, height } = canvas;
    const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height);
    const pixels = new Uint8Array(width * height);
    const errors = new Float32Array(width + 2);
    const next = new Float32Array(width + 2);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const k = (y * width + x) * 4;
        const alpha = data[k + 3] / 255;
        const lightness = (0.299 * data[k] + 0.587 * data[k + 1] + 0.114 * data[k + 2]) * alpha + 255 * (1 - alpha);
        const corrected = lightness + errors[x + 1];
        const black = corrected < 145;
        pixels[y * width + x] = black ? 1 : 0;
        const diff = corrected - (black ? 0 : 255);
        errors[x + 2] += diff * 7 / 16;
        next[x] += diff * 3 / 16;
        next[x + 1] += diff * 5 / 16;
        next[x + 2] += diff / 16;
      }
      errors.set(next); next.fill(0);
    }
    return { width, height, pixels };
  }

  function rasterStrip(img, startY, stripHeight) {
    const bytesPerRow = Math.ceil(img.width / 8);
    const out = new Uint8Array(8 + bytesPerRow * stripHeight);
    // GS v 0, m=0: raster bit image at 1x scale.
    out.set([0x1d, 0x76, 0x30, 0x00, bytesPerRow & 255, bytesPerRow >> 8, stripHeight & 255, stripHeight >> 8]);
    let n = 8;
    for (let y = startY; y < startY + stripHeight; y++) {
      for (let bx = 0; bx < bytesPerRow; bx++) {
        let bits = 0;
        for (let b = 0; b < 8; b++) {
          const x = bx * 8 + b;
          if (x < img.width && img.pixels[y * img.width + x]) bits |= 0x80 >> b;
        }
        out[n++] = bits;
      }
    }
    return out;
  }

  async function print(receipt, browserPrint) {
    if (!port) { browserPrint(); return; }
    if (printing) { report('앞선 영수증을 전송하는 중입니다.', true); return; }
    printing = true;
    let writer;
    try {
      report('디자인·한글·QR을 이미지로 변환 중…');
      const img = blackPixels(await snapshot(receipt));
      writer = port.writable.getWriter();
      await writer.write(new Uint8Array([0x1b, 0x40]));
      const strips = Math.ceil(img.height / 24);
      for (let i = 0; i < strips; i++) {
        const y = i * 24;
        await writer.write(rasterStrip(img, y, Math.min(24, img.height - y)));
        if (i % 8 === 0) report('COM5 데이터 전송: ' + Math.round((i + 1) / strips * 100) + '%');
      }
      await writer.write(new Uint8Array([0x0a, 0x0a, 0x0a]));
      report('전송 완료. 실제 영수증 출력과 QR 스캔을 확인하세요.');
    } catch (error) {
      report('USB 인쇄 실패: ' + error.message + ' (기존 브라우저 인쇄 사용 가능)', true);
      console.error('CPP300 receipt printing:', error);
    } finally { if (writer) writer.releaseLock(); printing = false; }
  }

  function mount() {
    document.querySelectorAll('.printbox').forEach(box => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'btn ku-serial-connect';
      button.textContent = 'USB 프린터 연결';
      button.onclick = connect;
      box.append(button);
      const note = document.createElement('span');
      note.className = 'note'; note.setAttribute('role', 'status');
      note.textContent = '미연결 시 기존 브라우저 인쇄 창 사용';
      box.insertAdjacentElement('afterend', note);
      badges.push(note);
    });
    if (!navigator.serial) report('이 브라우저는 Web Serial 미지원 · 기본 인쇄 사용', true);
  }

  navigator.serial?.addEventListener?.('disconnect', event => {
    if (port && event.target === port) {
      port = null;
      document.querySelectorAll('.ku-serial-connect').forEach(b => b.textContent = 'USB 프린터 연결');
      report('USB 연결 해제됨', true);
    }
  });
  window.CPP300Printer = { connect, print, isConnected: () => Boolean(port) };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
