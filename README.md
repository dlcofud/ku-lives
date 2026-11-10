# ku-lives CPP300 USB 영수증 인쇄 연동

기존 `2만분의 1` 웹사이트의 **출생·엔딩 영수증을 그대로** 이미지화하여 Windows에서 인식된 **COM5** 프린터에 출력하는 패치입니다. QR 코드, 한글과 기존 레이아웃을 함께 래스터 인쇄합니다.

## 적용 방법

1. 이 폴더의 `serial-printer.js`를 GitHub 저장소 `dlcofud/ku-lives`의 `index.html`과 같은 위치(저장소 최상위)에 업로드합니다.
2. 기존 `index.html` 파일의 `printReceipt(sel)` 함수 끝에서 아래 코드를 찾습니다.

```js
  pa.innerHTML = ""; pa.appendChild(copy);
  window.print();
```

다음과 같이 **딱 한 줄**을 교체합니다.

```js
  pa.innerHTML = ""; pa.appendChild(copy);
  if (window.CPP300Printer) await window.CPP300Printer.print(copy, () => window.print());
  else window.print();
```

3. 기존 `index.html` 맨 끝에 있는 `</script>`와 `</html>` 사이에 다음 한 줄을 추가합니다.

```html
<script src="./serial-printer.js"></script>
```

4. GitHub Pages 배포 후 Windows의 **Chrome 또는 Edge**에서 `https://dlcofud.github.io/ku-lives/`를 새로고침합니다.
5. 출생/엔딩 탭의 **USB 프린터 연결**을 누른 뒤 USB 포트 선택창에서 `VID_1CBE / PID_0002` 장치를 선택합니다.
6. `영수증 인쇄`를 누르면 HTML 영수증 전체를 래스터 이미지로 변환해 Web Serial로 보냅니다. `자동 인쇄`는 **연결된 뒤에만** COM5로 인쇄합니다.

## 주의 사항

- 기본 통신: 9600 baud, 8-N-1, DTR/RTS 활성화. 사용자가 PowerShell로 확인한 포트 설정을 따릅니다.
- ESC/POS 래스터 명령 `GS v 0` 지원은 CPP300 실기기에서 **아직 검증되지 않았습니다**. 데이터 전송 성공이 실제 인쇄 성공을 뜻하지는 않습니다.
- 사이트는 이미 **80mm 용지(72mm 인쇄 폭)**를 전제로 합니다. 스크립트는 576 dots를 사용합니다. 58mm 프린터면 `DOTS = 384` 및 영수증 너비 조절이 필요합니다.
- 코드가 `html2canvas@1.4.1`을 jsDelivr에서 불러옵니다. 행사 현장에서 인터넷이 끊기면 이미지 변환에 실패할 수 있습니다. 오프라인 운영 전에는 라이브러리를 저장소에 직접 배포하세요.
- 9600 baud에서 이미지 출력은 글자 전용 인쇄보다 느리고, 영수증 길이에 따라 수십 초 이상 걸릴 수 있습니다. 실제 장비에서 QR 인식과 출력 시간을 사전 점검하세요.
- 보안상 브라우저가 USB 포트 접근 권한을 요구합니다. 스마트폰 브라우저에서는 이 방법을 사용할 수 없습니다.
- USB 프린터를 연결하지 않으면 기존 `window.print()` 인쇄창이 그대로 작동합니다.
