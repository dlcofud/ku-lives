/* KU Lives — AHAPOS CPP-3000 Web Serial receipt printing.
 * Replaces serial-printer.js; keep existing index.html CPP300Printer.print(...) integration.
 * Safety: serial job queue, bounded raster blocks, conservative pacing, post-job cooldown.
 * IMPORTANT: Web Serial write() does not acknowledge printing. No code can promise
 * zero corruption without verified printer status / hardware flow control support.
 */
(() => {
  'use strict';

  const CONFIG = Object.freeze({
    USB_VENDOR_ID: 0x1cbe,
    USB_PRODUCT_ID: 0x0002,
    BAUD_RATE: 9600,
    DOT_WIDTH: 576,          // 80 mm paper, ~72 mm printable width
    BLOCK_HEIGHT: 16,       // 576 / 8 * 16 = 1152 bytes per block
    AFTER_BLOCK_MS: 90,     // balance of throughput and printer buffering
    AFTER_JOB_MS: 2500,     // cooldown before the next receipt
    MAX_WAITING_JOBS: 3,    // prevent dozens of accidental auto-print requests
    AUTO_CUT: true,
    CUT_MODE: 0,         // ESC/POS GS V 0: full cut (if supported)
    PRINT_TIMEOUT_MS: 240000
  });

  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  let port = null;
  let connecting = false;
  let running = false;
  let queue = [];
  let rendererPromise = null;
  const indicators = [];

  function notify(message, error = false) {
    indicators.forEach(el => {
      el.textContent = message;
      el.style.color = error ? '#bd2840' : '';
    });
  }

  function buttonsConnected(connected) {
    document.querySelectorAll('.ku-serial-connect').forEach(b => {
      b.textContent = connected ? 'USB 연결됨' : 'USB 프린터 연결';
    });
  }

  async function connect() {
    if (!('serial' in navigator)) {
      notify('Windows Chrome/Edge에서 USB 직접 출력이 가능합니다.', true);
      alert('현재 브라우저에서 Web Serial을 지원하지 않습니다. Windows Chrome/Edge에서 열어 주세요.');
      return;
    }
    if (connecting || port) {
      notify(port ? '프린터가 이미 연결되어 있어요.' : '프린터 연결 중…');
      return;
    }
    connecting = true;
    let selected;
    try {
      selected = await navigator.serial.requestPort({
        filters: [{ usbVendorId: CONFIG.USB_VENDOR_ID, usbProductId: CONFIG.USB_PRODUCT_ID }]
      });
      await selected.open({ baudRate: CONFIG.BAUD_RATE, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
      try {
        await selected.setSignals({ dataTerminalReady: true, requestToSend: true });
      } catch (_) {
        // Some virtual COM drivers do not support signal toggling.
      }
      port = selected;
      buttonsConnected(true);
      notify('CPP-3000 연결됨 · 인쇄 준비 완료');
    } catch (error) {
      if (selected) { try { await selected.close(); } catch (_) {} }
      notify('USB 연결 실패: ' + error.message, true);
    } finally {
      connecting = false;
    }
  }

  function getRenderer() {
    if (typeof window.html2canvas === 'function') return Promise.resolve(window.html2canvas);
    if (!rendererPromise) {
      rendererPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
        script.onload = () => typeof window.html2canvas === 'function'
          ? resolve(window.html2canvas)
          : reject(new Error('이미지 변환 라이브러리를 실행할 수 없습니다.'));
        script.onerror = () => reject(new Error('이미지 라이브러리를 내려받을 수 없습니다. 인터넷 연결을 확인하세요.'));
        document.head.append(script);
      }).catch(error => { rendererPromise = null; throw error; });
    }
    return rendererPromise;
  }

  // Capture the EXACT receipt DOM (Korean, QR SVG, all layout) rather than
  // relying on the printer's built-in text/codepage support.
  async function captureReceipt(receipt) {
    const render = await getRenderer();
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;top:0;left:-10000px;width:330px;background:#fff;pointer-events:none;z-index:-1';
    const node = receipt.cloneNode(true);
    node.classList.remove('printing');
    node.removeAttribute('id');
    node.querySelectorAll('[id]').forEach(child => child.removeAttribute('id'));
    node.style.cssText += ';width:330px;max-width:none;margin:0;background:#fff;color:#000;box-shadow:none;animation:none;mask:none;-webkit-mask:none';
    node.querySelectorAll('.small,.stamps i').forEach(child => { child.style.color = '#000'; });
    holder.append(node);
    document.body.append(holder);
    try {
      await document.fonts.ready;
      return await render(node, {
        backgroundColor: '#ffffff',
        scale: CONFIG.DOT_WIDTH / 330,
        width: 330,
        useCORS: true,
        logging: false,
        scrollY: -window.scrollY
      });
    } finally {
      holder.remove();
    }
  }

  function toMonochrome(canvas) {
    const { width, height } = canvas;
    if (width !== CONFIG.DOT_WIDTH || height < 1 || height > 20000)
      throw new Error('영수증 이미지 크기가 예상 범위를 벗어났습니다.');
    const rgba = canvas.getContext('2d', { willReadFrequently: true })
      .getImageData(0, 0, width, height).data;
    const pixels = new Uint8Array(width * height);
    const errors = new Float32Array(width + 2);
    const next = new Float32Array(width + 2);
    // Floyd-Steinberg dithering: preserve Korean glyphs and QR readability.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        const alpha = rgba[offset + 3] / 255;
        const gray = (0.299 * rgba[offset] + 0.587 * rgba[offset + 1] + 0.114 * rgba[offset + 2])
          * alpha + 255 * (1 - alpha);
        const value = gray + errors[x + 1];
        const isBlack = value < 145;
        pixels[y * width + x] = isBlack ? 1 : 0;
        const diff = value - (isBlack ? 0 : 255);
        errors[x + 2] += diff * 7 / 16;
        next[x] += diff * 3 / 16;
        next[x + 1] += diff * 5 / 16;
        next[x + 2] += diff / 16;
      }
      errors.set(next);
      next.fill(0);
    }
    return { width, height, pixels };
  }

  function rasterBlock(image, fromY, rows) {
    const widthBytes = image.width >> 3;
    const result = new Uint8Array(8 + widthBytes * rows);
    // ESC/POS GS v 0: [1D 76 30 00 xL xH yL yH] + 1-bit image data
    result.set([0x1d, 0x76, 0x30, 0x00,
      widthBytes & 255, widthBytes >> 8, rows & 255, rows >> 8]);
    let at = 8;
    for (let y = fromY; y < fromY + rows; y++) {
      for (let bx = 0; bx < widthBytes; bx++) {
        let word = 0;
        for (let bit = 0; bit < 8; bit++) {
          if (image.pixels[y * image.width + bx * 8 + bit]) word |= 0x80 >> bit;
        }
        result[at++] = word;
      }
    }
    return result;
  }

  async function sendImage(image) {
    if (!port?.writable) throw new Error('USB 포트가 연결되지 않았습니다.');
    const writer = port.writable.getWriter();
    let succeeded = false;
    try {
      await writer.write(new Uint8Array([0x1b, 0x40])); // ESC @ reset
      await pause(200);
      const count = Math.ceil(image.height / CONFIG.BLOCK_HEIGHT);
      for (let i = 0; i < count; i++) {
        const start = i * CONFIG.BLOCK_HEIGHT;
        const rows = Math.min(CONFIG.BLOCK_HEIGHT, image.height - start);
        // Send a self-contained block; never split a command header from its data.
        await writer.write(rasterBlock(image, start, rows));
        // Web Serial write() is only an OS handoff, not an on-paper acknowledgement.
        await pause(CONFIG.AFTER_BLOCK_MS);
        if (i % 4 === 0 || i === count - 1) {
          notify('CPP-3000 출력 데이터 전송 ' + Math.round((i + 1) * 100 / count) + '% · 대기 ' + queue.length + '건');
        }
      }
      // Feed paper beyond cutter position; cut only after all image blocks.
      await pause(300);
      await writer.write(new Uint8Array([0x0a, 0x0a, 0x0a]));
      await pause(300);
      if (CONFIG.AUTO_CUT) {
        await writer.write(new Uint8Array([0x1d, 0x56, CONFIG.CUT_MODE]));
      }
      succeeded = true;
    } finally {
      writer.releaseLock();
      if (succeeded) {
        notify('전송 완료 · 다음 영수증 전 프린터 처리 대기 중…');
        await pause(CONFIG.AFTER_JOB_MS);
      }
    }
  }

  async function drainQueue() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const job = queue.shift();
        try {
          if (!port) throw new Error('프린터가 연결 해제됐습니다.');
          notify('영수증 이미지 준비 중… · 대기 ' + queue.length + '건');
          // Image capture happens inside the queue so two jobs cannot stream simultaneously.
          const image = toMonochrome(await captureReceipt(job.receipt));
          await sendImage(image);
          notify('인쇄 데이터 전송 완료 · 대기 ' + queue.length + '건 (종이 상태 확인)');
          job.resolve(true);
        } catch (error) {
          notify('프린터 오류: ' + error.message + ' · 실패 작업을 자동 재전송하지 않습니다.', true);
          console.error('[CPP-3000]', error);
          job.resolve(false);
          // After an uncertain partial write, don't send following jobs automatically.
          for (const pending of queue.splice(0)) pending.resolve(false);
          break;
        }
      }
    } finally {
      running = false;
    }
  }

  // Compatible with existing index.html call:
  // await CPP300Printer.print(receiptClone, () => window.print())
  async function print(receipt, browserPrint) {
    if (!port) {
      if (typeof browserPrint === 'function') browserPrint();
      else notify('USB 연결 후 출력할 수 있습니다.', true);
      return false;
    }
    if (!receipt) { notify('영수증 요소를 찾을 수 없습니다.', true); return false; }
    if (queue.length >= CONFIG.MAX_WAITING_JOBS) {
      notify('인쇄 대기열이 가득 찼습니다. 중복 인쇄를 방지하기 위해 추가 요청을 거절합니다.', true);
      return false;
    }
    // Clone at request time: live receipt DOM may change during earlier jobs.
    const frozen = receipt.cloneNode(true);
    return new Promise(resolve => {
      queue.push({ receipt: frozen, resolve });
      notify('인쇄 요청 등록 · 대기 ' + queue.length + '건');
      void drainQueue();
    });
  }

  function mount() {
    document.querySelectorAll('.printbox').forEach(box => {
      if (box.querySelector('.ku-serial-connect')) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn ku-serial-connect';
      button.textContent = 'USB 프린터 연결';
      button.addEventListener('click', connect);
      box.append(button);
      const note = document.createElement('span');
      note.className = 'note';
      note.setAttribute('role', 'status');
      note.textContent = 'USB 미연결 시 기존 브라우저 인쇄를 사용합니다.';
      box.insertAdjacentElement('afterend', note);
      indicators.push(note);
    });
    if (!('serial' in navigator)) notify('Web Serial 미지원: 브라우저 인쇄만 가능', true);
  }

  if ('serial' in navigator) {
    navigator.serial.addEventListener('disconnect', event => {
      if (port && event.target === port) {
        port = null;
        buttonsConnected(false);
        notify('USB 연결이 끊어졌습니다. 인쇄 상태를 확인하고 다시 연결하세요.', true);
      }
    });
  }
  window.CPP300Printer = { connect, print, isConnected: () => !!port, pendingCount: () => queue.length };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
