"""
2만분의 1 부스 — 엔딩존 노트북에서 돌리는 '이 삶을 한마디로' 서버

※ API 없이도 됩니다: 사이트에 미리 써 둔 '문장 은행'이 기본값이라, 이 서버를 안 켜도 한마디는 나옵니다.
  이 서버는 AI로 더 개인화된 문장을 원할 때만 켭니다. 무료로 쓰는 방법 두 가지:
  - Ollama (내 노트북에서 도는 무료 모델, 인터넷·요금 없음):  https://ollama.com 설치 → ollama pull qwen2.5:7b
      python line_server.py --provider ollama --model qwen2.5:7b
  - Gemini 무료 등급 (Google AI Studio 키, 하루 호출 수 제한, 무료 등급 입력은 구글 학습에 쓰일 수 있음):
      export GEMINI_API_KEY=<AI Studio에서 받은 키>
      python line_server.py --provider gemini --test     ← 먼저 예시로 3번 만들어 보기
      python line_server.py --provider gemini            ← 부스 당일 (모델은 키로 쓸 수 있는 Flash-Lite를 자동으로 고름)
  - Claude API (유료, 호출 1번에 약 1~2원 수준):  export ANTHROPIC_API_KEY=...  python line_server.py --provider claude

내 컴퓨터(엔딩존 노트북)에서만 AI를 부른다.
  - 이미 만든 적 있는 삶이면 저장해 둔 문장을 다시 띄운다 (API 호출 없음)
  - 처음 보는 삶이면 그때 한 번 만들고 lines.json에 저장한다
같은 영수증을 다시 찍으면 같은 문장, 다른 사람이라도 장면·선택·전환이 똑같은 삶이면 같은 문장이 나온다.

준비 (한 번만)
  1) 이 파일과 index.html을 같은 폴더에 둔다
  2) 위 세 가지 중 하나를 준비 (키는 이 노트북에만 두고 깃헙에 올리지 않는다)
실행
  python line_server.py              → Ollama로 실행, 브라우저에서 http://localhost:8000 열기 (엔딩존 화면)
  python line_server.py --mock       → API 없이 규칙 문장으로 동작만 확인
  python line_server.py --port 8080
확인
  http://localhost:8000/lines        → 지금까지 만든 문장 목록 (검수용)
"""
import argparse, hashlib, json, os, re, threading, time, urllib.request
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

HERE = os.path.dirname(os.path.abspath(__file__))
STORE = os.path.join(HERE, "lines.json")
MODEL = os.environ.get("MODEL", "claude-haiku-4-5")
LOCK = threading.Lock()

STIGMA = ["냄새", "시끄러", "그런 사람", "이런 사람", "공짜밥", "나이 먹고", "남자가 무슨", "외국 사람은", "진지충", "집값", "애 생기면", "어르신은", "와이프", "벌레"]
JUDGE = ["용감", "비겁", "현명", "잘못", "실패", "패배", "나약", "훌륭", "어리석", "착한", "나쁜"]
IDENTITY = ["장애인", "외국인", "이주민", "성소수자", "동성애", "여자", "남자", "여성", "남성", "가난", "부자", "빈곤", "다문화"]


def load():
    try:
        with open(STORE, encoding="utf-8") as f: return json.load(f)
    except Exception:
        return {"by_id": {}, "by_sig": {}}


def save(db):
    tmp = STORE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f: json.dump(db, f, ensure_ascii=False, indent=1)
    os.replace(tmp, STORE)


def clip(s, n): return re.sub(r"[\n\r`]", " ", str(s or ""))[:n]


def prompt(f):
    steps = "\n".join(
        f"- {clip(s.get('stage'),10)}: '{clip(s.get('title'),30)}' ({clip(s.get('seat'),12)}) → {clip(s.get('did'),60)}"
        + (f" / 이 무렵: {', '.join(clip(x,20) for x in (s.get('life') or [])[:3])}" if s.get("life") else "")
        for s in (f.get("steps") or [])[:4])
    return f"""인권주간 부스의 인생 게임에서 한 참가자가 살아 본 가상의 삶입니다. 이 삶을 "당신은 ~ 사람이었습니다." 형식의 한 문장으로 적어 주세요.
규칙
- 문장 하나만, 따옴표·이모지·설명 없이.
- 고른 행동을 칭찬하거나 탓하지 않는다. 참은 것, 말한 것, 신고한 것 모두 그 사람이 할 수 있었던 일로 존중한다.
- 성별·장애·출신·성적 지향·소득 같은 정체성을 이름표처럼 붙이지 않는다.
- 차별하는 말이나 고정관념을 쓰지 않는다.
- '결정하는 자리'나 '옆에서 보는 자리'에서 가담하거나 침묵했다면 비난하지 말고, 그 순간이 남의 권리와 이어져 있었다는 것을 담담하게 담는다.
- 삶이 중간에 멈췄다면 그 사람 탓이 아니라는 것이 느껴지게 쓴다.
- 장면 이름이나 사건을 나열하지 않는다. 삶 전체를 꿰뚫는 가장 중요한 한 가지만 담는다.
- 30~45자 정도로 짧고 쉬운 말로. 과장된 비유는 피한다.
- 반드시 "당신은"으로 시작해 "사람이었습니다."로 끝낸다.
좋은 예
- 당신은 참아야 할 때와 말해야 할 때 사이를 오가며 살아온 사람이었습니다.
- 당신은 혼자 삼키기보다 누군가와 함께 버티는 쪽을 골라 온 사람이었습니다.
- 당신은 오래 참았지만 끝내 자기 목소리를 찾은 사람이었습니다.
삶의 기록
{steps}{chr(10) + '- 이 삶은 중간에 멈췄습니다.' if f.get('ended') else ''}"""


def ok(t):
    t = re.sub(r'^["\'“”‘’]+|["\'“”‘’]+$', "", str(t or "").strip()).split("\n")[0].strip()
    if t.endswith("다"): t += "."
    if not (t.startswith("당신") and t.endswith("사람이었습니다.")): return None
    if not (12 <= len(t) <= 80): return None
    if any(w in t for w in STIGMA + JUDGE + IDENTITY): return None
    return t


def post_json(url, body, headers, timeout=30):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"content-type": "application/json", **headers})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def ask_once(provider, model, text):
    if provider == "claude":
        d = post_json("https://api.anthropic.com/v1/messages", {"model": model or "claude-haiku-4-5", "max_tokens": 120, "messages": [{"role": "user", "content": text}]},
                      {"x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01"})
        return "".join(b.get("text", "") for b in d.get("content", []))
    if provider == "gemini":
        d = post_json(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                      {"contents": [{"parts": [{"text": text}]}], "generationConfig": {"maxOutputTokens": 120, "temperature": 0.5}},
                      {"x-goog-api-key": os.environ["GEMINI_API_KEY"]})
        return "".join(p.get("text", "") for c in d.get("candidates", []) for p in c.get("content", {}).get("parts", []))
    if provider == "ollama":   # 노트북 안에서만 도는 무료 모델
        d = post_json("http://localhost:11434/api/generate", {"model": model or "qwen2.5:7b", "prompt": text, "stream": False, "options": {"num_predict": 120}}, {}, timeout=60)
        return d.get("response", "")
    return ""


def pick_gemini_model():
    """AI Studio 키로 쓸 수 있는 모델 목록을 받아 Flash-Lite(없으면 Flash)를 고른다. 모델 이름을 몰라도 된다."""
    req = urllib.request.Request("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
                                 headers={"x-goog-api-key": os.environ["GEMINI_API_KEY"]})
    with urllib.request.urlopen(req, timeout=15) as r:
        models = json.load(r).get("models", [])
    names = [m["name"].split("/")[-1] for m in models if "generateContent" in m.get("supportedGenerationMethods", [])]
    names = [n for n in names if n.startswith("gemini") and not re.search(r"preview|exp|tts|image|live|audio|embedding|thinking", n)]
    for kind in ("flash-lite", "flash"):
        cands = sorted([n for n in names if kind in n and (kind == "flash-lite" or "lite" not in n)], reverse=True)
        if cands: return cands[0]
    raise RuntimeError("쓸 수 있는 Flash 계열 모델을 찾지 못했습니다. --model 로 직접 넣어 주세요. 후보: " + ", ".join(names[:10]))


SAMPLE = {"ended": False, "steps": [
    {"stage": "청소년기", "title": "말투 흉내", "seat": "당사자", "did": "상담실을 통해 문제를 알린다", "life": []},
    {"stage": "청년기", "title": "직무 대신 말투", "seat": "당사자", "did": "서울말로 바꿔 대답한다", "life": []},
    {"stage": "중장년기", "title": "면접관 자리에서", "seat": "옆에서 보는 자리", "did": "직무와 관계없는 질문이니 넘어가자고 말한다", "life": []},
    {"stage": "노년기", "title": "문 닫은 지점", "seat": "당사자", "did": "손주에게 부탁하려고 그냥 돌아간다", "life": []}]}


def ask(facts):
    for attempt in range(2):                      # 규칙에 어긋나면 한 번만 다시 시도
        try:
            line = ok(ask_once(Handler.provider, Handler.model, prompt(facts)))
            if line and any(len(t) >= 3 and t in line for t in (s.get("title", "") for s in facts.get("steps", []))):
                line = None                       # 장면 제목을 그대로 옮긴 문장은 버림 (한 문장 요약만)
            if line: return line
        except Exception as e:
            print("  AI 호출 오류:", e)
            return None
    return None


def mock_line(facts):
    return "당신은 [모의] " + " · ".join(clip(s.get("title"), 12) for s in facts.get("steps", [])) + "을 지나온 사람이었습니다."


class Handler(SimpleHTTPRequestHandler):
    mock = False
    provider, model = "claude", ""

    def __init__(self, *a, **k): super().__init__(*a, directory=HERE, **k)

    def log_message(self, fmt, *args): pass       # 정적 파일 요청 로그는 숨김

    def send_json(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code); self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        if self.path.startswith("/lines"):
            db = load(); return self.send_json({"count": len(db["by_id"]), "lines": db["by_id"]})
        return super().do_GET()

    def do_POST(self):
        if self.path != "/line": return self.send_json({"error": "not found"}, 404)
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        except Exception:
            return self.send_json({"line": None}, 400)
        rid, facts = str(req.get("id", ""))[:12], req.get("facts") or {}
        sig = hashlib.sha1(str(req.get("sig", "")).encode()).hexdigest()[:16]
        with LOCK:
            db = load()
            hit = db["by_id"].get(rid)
            if hit and hit.get("sig") == sig:                        # 같은 영수증, 같은 삶
                print(f"  {rid}: 저장된 문장"); return self.send_json({"line": hit["line"], "by": hit["by"], "cached": True})
            if sig in db["by_sig"]:                                   # 다른 영수증이지만 똑같은 삶
                line, by = db["by_sig"][sig]["line"], db["by_sig"][sig]["by"]
                db["by_id"][rid] = {"line": line, "by": by, "sig": sig, "at": time.strftime("%H:%M:%S")}; save(db)
                print(f"  {rid}: 같은 삶 문장 재사용"); return self.send_json({"line": line, "by": by, "cached": True})
        # 처음 보는 삶 → 생성 (잠금 밖에서, 다른 요청을 막지 않게)
        line = mock_line(facts) if self.mock else ask(facts)
        if not line: return self.send_json({"line": None})          # 사이트가 규칙 기반 문장으로 대신함
        by = "mock" if self.mock else "ai"
        with LOCK:
            db = load()
            db["by_sig"][sig] = {"line": line, "by": by}
            db["by_id"][rid] = {"line": line, "by": by, "sig": sig, "at": time.strftime("%H:%M:%S")}
            save(db)
        print(f"  {rid}: 새로 생성 → {line}")
        return self.send_json({"line": line, "by": by, "cached": False})


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--mock", action="store_true", help="API 없이 동작 확인")
    ap.add_argument("--provider", choices=["ollama", "gemini", "claude"], default="ollama")
    ap.add_argument("--model", default="")
    ap.add_argument("--test", action="store_true", help="예시 삶 하나로 한마디를 만들어 보고 끝냄")
    a = ap.parse_args()
    Handler.mock, Handler.provider, Handler.model = a.mock, a.provider, a.model
    need = {"claude": "ANTHROPIC_API_KEY", "gemini": "GEMINI_API_KEY"}.get(a.provider)
    if not a.mock and need and not os.environ.get(need):
        print(f"! {need}가 없습니다. 한마디는 사이트의 문장 은행에서 나옵니다.")
    if a.provider == "gemini" and not a.model and os.environ.get("GEMINI_API_KEY"):
        try:
            Handler.model = pick_gemini_model()
        except Exception as e:
            print("! 모델 목록을 받지 못했습니다:", e)
    print(f"AI: {'모의' if a.mock else a.provider} {Handler.model}")
    if a.test:
        for i in range(3):
            raw = ask_once(Handler.provider, Handler.model, prompt(SAMPLE)).strip()
            print(f"  시도 {i+1}: {raw}")
            print("    →", "통과" if ok(raw) else "규칙 위반 (실제로는 다시 만들거나 문장 은행으로 대신함)")
        raise SystemExit
    print(f"엔딩존 화면: http://localhost:{a.port}   (저장 파일: {STORE})")
    ThreadingHTTPServer(("127.0.0.1", a.port), Handler).serve_forever()
