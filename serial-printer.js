/* KU Lives — AHAPOS CPP-3000 Web Serial receipt printing.
 * 기존 serial-printer.js 전체를 이 코드로 교체하세요.
 *
 * 기능:
 * - 웹사이트 기존 영수증 디자인 / 한글 / QR 코드 유지
 * - USB 가상 COM 포트로 ESC/POS 이미지 출력
 * - 연속 인쇄 요청 순차 처리
 * - 작은 이미지 블록과 보수적인 전송 간격
 * - 출력 후 대기 시간
 *
 * 참고: Web Serial write()는 실제 종이 인쇄 완료를 보장하지 않습니다.
 */

(() => {
  'use strict';

  const CONFIG = Object.freeze({
    USB_VENDOR_ID: 0x1cbe,
    USB_PRODUCT_ID: 0x0002,
    BAUD_RATE: 9600,
  
    DOT_WIDTH: 576,
    BLOCK_HEIGHT: 16,
  
    AFTER_BLOCK_MS: 90,
    AFTER_JOB_MS: 2500,
  
    MAX_WAITING_JOBS: 3
  });

  const pause = ms =>
    new Promise(resolve => setTimeout(resolve, ms));

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
    document.querySelectorAll('.ku-serial-connect')
      .forEach(button => {
        button.textContent = connected
          ? 'USB 연결됨'
          : 'USB 프린터 연결';
      });
  }

  // --------------------------------------------------
  // 1. USB 프린터 연결
  // --------------------------------------------------

  async function connect() {
    if (!('serial' in navigator)) {
      notify(
        'Windows Chrome/Edge에서 USB 직접 출력이 가능합니다.',
        true
      );

      alert(
        'Web Serial을 지원하는 Chrome 또는 Edge에서 열어 주세요.'
      );

      return;
    }

    if (connecting || port) {
      notify(
        port
          ? '프린터가 이미 연결되어 있습니다.'
          : '프린터 연결 중…'
      );
      return;
    }

    connecting = true;
    let selected;

    try {
      selected = await navigator.serial.requestPort({
        filters: [{
          usbVendorId: CONFIG.USB_VENDOR_ID,
          usbProductId: CONFIG.USB_PRODUCT_ID
        }]
      });

      await selected.open({
        baudRate: CONFIG.BAUD_RATE,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none'
      });

      try {
        await selected.setSignals({
          dataTerminalReady: true,
          requestToSend: true
        });
      } catch (_) {
        // 일부 가상 COM 드라이버는 신호 설정을 지원하지 않음
      }

      port = selected;

      buttonsConnected(true);
      notify('CPP-3000 연결됨 · 인쇄 준비 완료');

    } catch (error) {
      if (selected) {
        try {
          await selected.close();
        } catch (_) {}
      }

      notify(
        'USB 연결 실패: ' + error.message,
        true
      );

    } finally {
      connecting = false;
    }
  }

  // --------------------------------------------------
  // 2. HTML 영수증을 이미지로 변환
  // --------------------------------------------------

  function getRenderer() {
    if (typeof window.html2canvas === 'function') {
      return Promise.resolve(window.html2canvas);
    }

    if (!rendererPromise) {
      rendererPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');

        script.src =
          'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';

        script.onload = () => {
          if (typeof window.html2canvas === 'function') {
            resolve(window.html2canvas);
          } else {
            reject(
              new Error('이미지 변환 라이브러리 실행 실패')
            );
          }
        };

        script.onerror = () => {
          reject(
            new Error('이미지 라이브러리를 불러오지 못했습니다.')
          );
        };

        document.head.append(script);

      }).catch(error => {
        rendererPromise = null;
        throw error;
      });
    }

    return rendererPromise;
  }

  async function captureReceipt(receipt) {
    const render = await getRenderer();

    const holder = document.createElement('div');

    holder.style.cssText = [
      'position:fixed',
      'top:0',
      'left:-10000px',
      'width:330px',
      'background:#fff',
      'pointer-events:none',
      'z-index:-1'
    ].join(';');

    const node = receipt.cloneNode(true);

    node.classList.remove('printing');
    node.removeAttribute('id');

    node.querySelectorAll('[id]').forEach(child => {
      child.removeAttribute('id');
    });

    node.style.cssText += [
      ';width:330px',
      'max-width:none',
      'margin:0',
      'background:#fff',
      'color:#000',
      'box-shadow:none',
      'animation:none',
      'mask:none',
      '-webkit-mask:none'
    ].join(';');

    node.querySelectorAll('.small,.stamps i')
      .forEach(child => {
        child.style.color = '#000';
      });

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

  // --------------------------------------------------
  // 3. 이미지를 흑백으로 변환
  // --------------------------------------------------

  function toMonochrome(canvas) {
    const { width, height } = canvas;

    if (
      width !== CONFIG.DOT_WIDTH ||
      height < 1 ||
      height > 20000
    ) {
      throw new Error(
        '영수증 이미지 크기가 예상 범위를 벗어났습니다.'
      );
    }

    const rgba = canvas
      .getContext('2d', { willReadFrequently: true })
      .getImageData(0, 0, width, height).data;

    const pixels = new Uint8Array(width * height);

    const errors = new Float32Array(width + 2);
    const next = new Float32Array(width + 2);

    // Floyd–Steinberg 디더링
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;

        const alpha = rgba[offset + 3] / 255;

        const gray = (
          0.299 * rgba[offset] +
          0.587 * rgba[offset + 1] +
          0.114 * rgba[offset + 2])
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

  // --------------------------------------------------
  // 4. ESC/POS 이미지 블록 생성
  // --------------------------------------------------

  function rasterBlock(image, fromY, rows) {
    const widthBytes = image.width >> 3;

    const result = new Uint8Array(
      8 + widthBytes * rows
    );

    // ESC/POS GS v 0
    result.set([
      0x1d, 0x76, 0x30, 0x00,
      widthBytes & 255,
      widthBytes >> 8,
      rows & 255,
      rows >> 8
    ]);

    let at = 8;

    for (let y = fromY; y < fromY + rows; y++) {
      for (let bx = 0; bx < widthBytes; bx++) {
        let word = 0;

        for (let bit = 0; bit < 8; bit++) {
          if (
            image.pixels[
              y * image.width + bx * 8 + bit
            ]
          ) {
            word |= 0x80 >> bit;
          }
        }

        result[at++] = word;
      }
    }

    return result;
  }

  // --------------------------------------------------
  // 5. COM 포트로 이미지 전송
  // --------------------------------------------------

  async function sendImage(image) {
    if (!port?.writable) {
      throw new Error('USB 프린터가 연결되지 않았습니다.');
    }

    const writer = port.writable.getWriter();

    let succeeded = false;

    try {
      // 프린터 초기화
      await writer.write(
        new Uint8Array([0x1b, 0x40])
      );

      await pause(200);

      const count = Math.ceil(
        image.height / CONFIG.BLOCK_HEIGHT
      );

      for (let i = 0; i < count; i++) {
        const start = i * CONFIG.BLOCK_HEIGHT;

        const rows = Math.min(
          CONFIG.BLOCK_HEIGHT,
          image.height - start
        );

        // 완전한 이미지 블록 단위로 전송
        await writer.write(
          rasterBlock(image, start, rows)
        );

        // 프린터 수신 버퍼 과부하 가능성 감소
        await pause(CONFIG.AFTER_BLOCK_MS);

        if (
          i % 4 === 0 ||
          i === count - 1
        ) {
          const progress = Math.round(
            (i + 1) * 100 / count
          );

          notify(
            'CPP-3000 데이터 전송 ' +
            progress +
            '% · 대기 ' +
            queue.length +
            '건'
          );
        }
      }

      // 마지막 용지 배출
      await writer.write(
        new Uint8Array([0x0a, 0x0a, 0x0a])
      );

      succeeded = true;

    } finally {
      writer.releaseLock();

      if (succeeded) {
        notify(
          '데이터 전송 완료 · 프린터 처리 대기 중…'
        );

        await pause(CONFIG.AFTER_JOB_MS);
      }
    }
  }

  // --------------------------------------------------
  // 6. 연속 출력 대기열
  // --------------------------------------------------

  async function drainQueue() {
    if (running) return;

    running = true;

    try {
      while (queue.length) {
        const job = queue.shift();

        try {
          if (!port) {
            throw new Error(
              '프린터 연결이 해제되었습니다.'
            );
          }

          notify(
            '영수증 이미지 준비 중… · 대기 ' +
            queue.length +
            '건'
          );

          const canvas = await captureReceipt(
            job.receipt
          );

          const image = toMonochrome(canvas);

          await sendImage(image);

          notify(
            '인쇄 데이터 전송 완료 · 대기 ' +
            queue.length +
            '건'
          );

          job.resolve(true);

        } catch (error) {
          notify(
            '프린터 오류: ' +
            error.message +
            ' · 자동 재전송하지 않습니다.',
            true
          );

          console.error(
            '[CPP-3000]',
            error
          );

          job.resolve(false);

          // 오류 발생 시 후속 인쇄 중단
          for (
            const pending of queue.splice(0)
          ) {
            pending.resolve(false);
          }

          break;
        }
      }

    } finally {
      running = false;
    }
  }

  // --------------------------------------------------
  // 7. 사이트의 기존 영수증 인쇄 함수와 연결
  // --------------------------------------------------

  async function print(receipt, browserPrint) {
    if (!port) {
      if (typeof browserPrint === 'function') {
        browserPrint();
      } else {
        notify(
          'USB 프린터를 연결해 주세요.',
          true
        );
      }

      return false;
    }

    if (!receipt) {
      notify(
        '영수증 요소를 찾을 수 없습니다.',
        true
      );
      return false;
    }

    if (
      queue.length >= CONFIG.MAX_WAITING_JOBS
    ) {
      notify(
        '인쇄 대기열이 가득 찼습니다.',
        true
      );
      return false;
    }

    // 요청 시점의 영수증을 고정
    const frozen = receipt.cloneNode(true);

    return new Promise(resolve => {
      queue.push({
        receipt: frozen,
        resolve
      });

      notify(
        '인쇄 요청 등록 · 대기 ' +
        queue.length +
        '건'
      );

      void drainQueue();
    });
  }

  // --------------------------------------------------
  // 8. 웹사이트에 USB 연결 버튼 추가
  // --------------------------------------------------

  function mount() {
    document.querySelectorAll('.printbox')
      .forEach(box => {
        if (
          box.querySelector('.ku-serial-connect')
        ) {
          return;
        }

        const button = document.createElement('button');

        button.type = 'button';
        button.className = 'btn ku-serial-connect';
        button.textContent = 'USB 프린터 연결';

        button.addEventListener(
          'click',
          connect
        );

        box.append(button);

        const note = document.createElement('span');

        note.className = 'note';
        note.setAttribute('role', 'status');

        note.textContent =
          'USB 미연결 시 기존 브라우저 인쇄 사용';

        box.insertAdjacentElement(
          'afterend',
          note
        );

        indicators.push(note);
      });

    if (!('serial' in navigator)) {
      notify(
        'Web Serial 미지원: 브라우저 인쇄만 가능',
        true
      );
    }
  }

  // --------------------------------------------------
  // 9. USB 연결 해제 감지
  // --------------------------------------------------

  if ('serial' in navigator) {
    navigator.serial.addEventListener(
      'disconnect',
      event => {
        if (
          port &&
          event.target === port
        ) {
          port = null;

          buttonsConnected(false);

          notify(
            'USB 연결이 끊어졌습니다. 다시 연결하세요.',
            true
          );
        }
      }
    );
  }

  // --------------------------------------------------
  // 10. 기존 index.html에 API 제공
  // --------------------------------------------------

  window.CPP300Printer = {
    connect,
    print,
    isConnected: () => !!port,
    pendingCount: () => queue.length
  };

  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      mount
    );
  } else {
    mount();
  }

})();
