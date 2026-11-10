/*
 * KU Lives — AHAPOS CPP-3000
 * USB Web Serial Receipt Printer
 *
 * 기능
 * 1. 웹사이트 영수증 디자인 유지
 * 2. 한글 및 QR 코드 이미지 인쇄
 * 3. 출력 대기열과 순차 처리
 * 4. 블록 단위 데이터 전송
 * 5. 인쇄 후 자동 커터 명령
 *
 * Chrome / Edge + Web Serial 사용
 */

(() => {
  "use strict";

  // ==========================================
  // 1. 프린터 설정
  // ==========================================

  const CONFIG = Object.freeze({
    USB_VENDOR_ID: 0x1cbe,
    USB_PRODUCT_ID: 0x0002,

    BAUD_RATE: 9600,

    DOT_WIDTH: 576,
    BLOCK_HEIGHT: 16,

    // 데이터 전송 사이의 간격
    AFTER_BLOCK_MS: 90,

    // 마지막 인쇄와 절단 명령 사이의 대기
    BEFORE_CUT_MS: 500,

    // 다음 영수증 전까지 대기
    AFTER_JOB_MS: 2500,

    MAX_WAITING_JOBS: 3,

    // 자동 커터 사용
    AUTO_CUT: true,

    // 0 = 완전 절단, 1 = 부분 절단
    CUT_MODE: 0
  });

  const sleep = ms =>
    new Promise(resolve => setTimeout(resolve, ms));

  let port = null;
  let connecting = false;
  let printing = false;
  let queue = [];
  let rendererPromise = null;

  const indicators = [];

  // ==========================================
  // 2. 상태 메시지
  // ==========================================

  function notify(message, error = false) {
    indicators.forEach(el => {
      el.textContent = message;
      el.style.color = error ? "#b4233c" : "";
    });
  }

  function updateButtons(connected) {
    document.querySelectorAll(".ku-serial-connect")
      .forEach(button => {
        button.textContent = connected
          ? "USB 연결됨"
          : "USB 프린터 연결";
      });
  }

  // ==========================================
  // 3. USB 프린터 연결
  // ==========================================

  async function connect() {
    if (!("serial" in navigator)) {
      notify(
        "Chrome 또는 Edge에서 USB 인쇄를 사용하세요.",
        true
      );

      alert(
        "이 브라우저는 Web Serial을 지원하지 않습니다."
      );

      return;
    }

    if (port || connecting) {
      notify(
        port
          ? "프린터가 이미 연결되어 있습니다."
          : "프린터 연결 중..."
      );
      return;
    }

    connecting = true;

    let selected = null;

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
        parity: "none",
        flowControl: "none"
      });

      try {
        await selected.setSignals({
          dataTerminalReady: true,
          requestToSend: true
        });
      } catch (_) {
        // 일부 USB 가상 COM 드라이버는 지원하지 않음
      }

      port = selected;

      updateButtons(true);

      notify("CPP-3000 USB 연결 완료");

    } catch (error) {
      if (selected) {
        try {
          await selected.close();
        } catch (_) {}
      }

      notify(
        "USB 연결 실패: " + error.message,
        true
      );

    } finally {
      connecting = false;
    }
  }

  // ==========================================
  // 4. HTML 이미지 변환 라이브러리
  // ==========================================

  function loadRenderer() {
    if (typeof window.html2canvas === "function") {
      return Promise.resolve(window.html2canvas);
    }

    if (!rendererPromise) {
      rendererPromise = new Promise((resolve, reject) => {
        const script = document.createElement("script");

        script.src =
          "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js";

        script.onload = () => {
          if (typeof window.html2canvas === "function") {
            resolve(window.html2canvas);
          } else {
            reject(
              new Error("이미지 변환 라이브러리 실행 실패")
            );
          }
        };

        script.onerror = () => {
          reject(
            new Error("이미지 라이브러리 다운로드 실패")
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

  // ==========================================
  // 5. 웹사이트 영수증 캡처
  // ==========================================

  async function captureReceipt(receipt) {
    const render = await loadRenderer();

    const holder = document.createElement("div");

    holder.style.cssText = [
      "position:fixed",
      "top:0",
      "left:-10000px",
      "width:330px",
      "background:#fff",
      "pointer-events:none",
      "z-index:-1"
    ].join(";");

    const node = receipt.cloneNode(true);

    node.classList.remove("printing");
    node.removeAttribute("id");

    node.querySelectorAll("[id]").forEach(el => {
      el.removeAttribute("id");
    });

    node.style.cssText += [
      ";width:330px",
      "max-width:none",
      "margin:0",
      "background:#fff",
      "color:#000",
      "box-shadow:none",
      "animation:none",
      "mask:none",
      "-webkit-mask:none"
    ].join(";");

    node.querySelectorAll(".small,.stamps i")
      .forEach(el => {
        el.style.color = "#000";
      });

    holder.append(node);
    document.body.append(holder);

    try {
      await document.fonts.ready;

      return await render(node, {
        backgroundColor: "#ffffff",
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

  // ==========================================
  // 6. 이미지를 흑백으로 변환
  // ==========================================

  function toMonochrome(canvas) {
    const { width, height } = canvas;

    if (
      width !== CONFIG.DOT_WIDTH ||
      height < 1 ||
      height > 20000
    ) {
      throw new Error(
        "영수증 이미지 크기가 올바르지 않습니다."
      );
    }

    const context = canvas.getContext("2d", {
      willReadFrequently: true
    });

    if (!context) {
      throw new Error("이미지 처리에 실패했습니다.");
    }

    const rgba = context.getImageData(
      0, 0, width, height
    ).data;

    const pixels = new Uint8Array(width * height);

    const errors = new Float32Array(width + 2);
    const next = new Float32Array(width + 2);

    // Floyd-Steinberg dithering
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

        const black = value < 145;

        pixels[y * width + x] = black ? 1 : 0;

        const diff = value - (black ? 0 : 255);

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

  // ==========================================
  // 7. ESC/POS 이미지 블록 생성
  // ==========================================

  function rasterBlock(image, fromY, rows) {
    const bytesPerRow = Math.ceil(image.width / 8);

    const data = new Uint8Array(
      8 + bytesPerRow * rows
    );

    // GS v 0 : Raster Bit Image
    data.set([
      0x1d, 0x76, 0x30, 0x00,
      bytesPerRow & 255,
      (bytesPerRow >> 8) & 255,
      rows & 255,
      (rows >> 8) & 255
    ]);

    let at = 8;

    for (let y = fromY; y < fromY + rows; y++) {
      for (let bx = 0; bx < bytesPerRow; bx++) {
        let bits = 0;

        for (let bit = 0; bit < 8; bit++) {
          const x = bx * 8 + bit;

          if (
            x < image.width &&
            image.pixels[
              y * image.width + x
            ]
          ) {
            bits |= 0x80 >> bit;
          }
        }

        data[at++] = bits;
      }
    }

    return data;
  }

  // ==========================================
  // 8. 프린터로 인쇄 데이터 전송
  // ==========================================

  async function sendImage(image) {
    if (!port || !port.writable) {
      throw new Error("USB 프린터가 연결되지 않았습니다.");
    }

    const writer = port.writable.getWriter();

    try {
      // ESC @ : 프린터 초기화
      await writer.write(
        new Uint8Array([0x1b, 0x40])
      );

      await sleep(150);

      const blocks = Math.ceil(
        image.height / CONFIG.BLOCK_HEIGHT
      );

      for (let i = 0; i < blocks; i++) {
        const fromY = i * CONFIG.BLOCK_HEIGHT;

        const rows = Math.min(
          CONFIG.BLOCK_HEIGHT,
          image.height - fromY
        );

        const data = rasterBlock(
          image,
          fromY,
          rows
        );

        // 이미지 블록 전송
        await writer.write(data);

        // 프린터 수신 버퍼에 여유를 줌
        await sleep(CONFIG.AFTER_BLOCK_MS);

        if (
          i % 8 === 0 ||
          i === blocks - 1
        ) {
          const progress = Math.round(
            (i + 1) * 100 / blocks
          );

          notify(
            "영수증 전송 중 " +
            progress +
            "% · 대기 " +
            queue.length +
            "건"
          );
        }
      }

      // ======================================
      // 9. 인쇄 종료 및 자동 절단
      // ======================================

      notify("영수증 마지막 부분 처리 중...");

      // 이미지 블록 전송이 모두 끝난 후
      await sleep(CONFIG.BEFORE_CUT_MS);

      // 하단 여백 확보
      await writer.write(
        new Uint8Array([
          0x0a,
          0x0a,
          0x0a
        ])
      );

      await sleep(300);

      if (CONFIG.AUTO_CUT) {
        notify("자동 절단 명령 전송 중...");

        // ESC/POS GS V
        // 0 = 완전 절단 요청
        // 1 = 부분 절단 요청
        await writer.write(
          new Uint8Array([
            0x1d,
            0x56,
            CONFIG.CUT_MODE
          ])
        );
      }

    } finally {
      writer.releaseLock();
    }

    // 다음 영수증 전까지 대기
    notify("전송 완료 · 다음 출력 준비 중...");

    await sleep(CONFIG.AFTER_JOB_MS);
  }

  // ==========================================
  // 10. 인쇄 대기열
  // ==========================================

  async function processQueue() {
    if (printing) return;

    printing = true;

    try {
      while (queue.length > 0) {
        const job = queue.shift();

        try {
          if (!port) {
            throw new Error(
              "USB 연결이 해제되었습니다."
            );
          }

          notify(
            "영수증 이미지 생성 중... · 대기 " +
            queue.length +
            "건"
          );

          const canvas = await captureReceipt(
            job.receipt
          );

          const image = toMonochrome(canvas);

          await sendImage(image);

          notify(
            "출력 데이터 전송 및 절단 명령 완료 · 대기 " +
            queue.length +
            "건"
          );

          job.resolve(true);

        } catch (error) {
          console.error(
            "[CPP-3000 PRINT ERROR]",
            error
          );

          notify(
            "인쇄 오류: " +
            error.message +
            " · 대기열 중단",
            true
          );

          job.resolve(false);

          // 오류 발생 시 중복 출력 방지
          for (const waiting of queue.splice(0)) {
            waiting.resolve(false);
          }

          break;
        }
      }

    } finally {
      printing = false;
    }
  }

  // ==========================================
  // 11. 영수증 출력 요청
  // ==========================================

  async function print(receipt, browserPrint) {
    // USB 프린터 미연결 시 기존 인쇄
    if (!port) {
      if (typeof browserPrint === "function") {
        browserPrint();
      }

      return false;
    }

    if (!receipt) {
      notify(
        "영수증 데이터를 찾을 수 없습니다.",
        true
      );
      return false;
    }

    if (queue.length >= CONFIG.MAX_WAITING_JOBS) {
      notify(
        "인쇄 대기열이 가득 찼습니다.",
        true
      );
      return false;
    }

    // 출력 요청 당시의 영수증 고정
    const frozen = receipt.cloneNode(true);

    return new Promise(resolve => {
      queue.push({
        receipt: frozen,
        resolve
      });

      notify(
        "인쇄 대기열 등록 · " +
        queue.length +
        "건"
      );

      void processQueue();
    });
  }

  // ==========================================
  // 12. 웹사이트 연결 버튼 생성
  // ==========================================

  function mount() {
    document.querySelectorAll(".printbox")
      .forEach(box => {
        if (
          box.querySelector(".ku-serial-connect")
        ) {
          return;
        }

        const button = document.createElement("button");

        button.type = "button";
        button.className = "btn ku-serial-connect";
        button.textContent = "USB 프린터 연결";

        button.addEventListener(
          "click",
          connect
        );

        box.append(button);

        const note = document.createElement("span");

        note.className = "note";
        note.setAttribute("role", "status");

        note.textContent =
          "USB 미연결 시 브라우저 인쇄 사용";

        box.insertAdjacentElement(
          "afterend",
          note
        );

        indicators.push(note);
      });

    if (!("serial" in navigator)) {
      notify(
        "Web Serial 미지원 · 브라우저 인쇄 사용",
        true
      );
    }
  }

  // ==========================================
  // 13. 프린터 연결 해제 감지
  // ==========================================

  if ("serial" in navigator) {
    navigator.serial.addEventListener(
      "disconnect",
      event => {
        if (
          port &&
          event.target === port
        ) {
          port = null;

          updateButtons(false);

          notify(
            "USB 프린터 연결이 끊어졌습니다.",
            true
          );
        }
      }
    );
  }

  // ==========================================
  // 14. 기존 사이트 API
  // ==========================================

  window.CPP300Printer = {
    connect,
    print,

    isConnected: () => Boolean(port),

    pendingCount: () => queue.length
  };

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      mount
    );
  } else {
    mount();
  }

})();
