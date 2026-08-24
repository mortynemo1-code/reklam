# Сервис озвучки с тремя движками:
#   edge   — нейроголоса Microsoft Edge (по умолчанию; бесплатно, нужен интернет)
#   yandex — Яндекс SpeechKit (нужен YANDEX_API_KEY; платно, самый надёжный)
#   silero — локальная модель Silero v4 (офлайн-фолбэк, без интернета)
# Выбор: TTS_ENGINE=auto|edge|yandex|silero (auto: yandex при наличии ключа,
# иначе edge; при ошибке сетевого движка — автоматический откат на silero).
#
# POST /tts {"text": "...", "voice": "..."} -> audio/mpeg или audio/wav
# GET  /health -> {"ok": true, ...}
import asyncio
import io
import json
import os
import re
import threading
import urllib.parse
import urllib.request
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "5002"))
ENGINE = os.environ.get("TTS_ENGINE", "auto").lower()
YANDEX_API_KEY = os.environ.get("YANDEX_API_KEY", "")
MODEL_PATH = os.environ.get("MODEL_PATH", "/app/v4_ru.pt")
MAX_TEXT = 4200
SAMPLE_RATE = 48000
CHUNK_LIMIT = 800

EDGE_VOICES = {
    "dmitry": "ru-RU-DmitryNeural",
    "svetlana": "ru-RU-SvetlanaNeural"
}
SILERO_VOICES = ["aidar", "baya", "kseniya", "xenia", "eugene"]
YANDEX_VOICES = ["alena", "filipp", "jane", "omazh", "zahar", "ermil",
                 "marina", "alexander", "kirill", "anton", "dasha",
                 "julia", "lera", "masha"]

# ── edge ───────────────────────────────────────────────────
async def _edge_bytes(text, voice):
    import edge_tts
    buf = bytearray()
    async for chunk in edge_tts.Communicate(text, voice).stream():
        if chunk["type"] == "audio":
            buf.extend(chunk["data"])
    if not buf:
        raise RuntimeError("edge-tts вернул пустой ответ")
    return bytes(buf)

def synth_edge(text, voice):
    v = EDGE_VOICES.get(voice or "dmitry", voice if voice.startswith("ru-") else "ru-RU-DmitryNeural")
    return asyncio.run(_edge_bytes(text, v)), "audio/mpeg"

# ── yandex speechkit ───────────────────────────────────────
def synth_yandex(text, voice):
    data = urllib.parse.urlencode({
        "text": text,
        "lang": "ru-RU",
        "voice": voice if voice in YANDEX_VOICES else "alena",
        "format": "mp3"
    }).encode()
    req = urllib.request.Request(
        "https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize",
        data=data,
        headers={"Authorization": "Api-Key " + YANDEX_API_KEY}
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read(), "audio/mpeg"

# ── silero (локальный фолбэк) ──────────────────────────────
_silero = {"model": None, "np": None}
_silero_lock = threading.Lock()

def _load_silero():
    if _silero["model"] is None:
        import numpy as np
        import torch
        torch.set_num_threads(int(os.environ.get("TTS_THREADS", "4")))
        model = torch.package.PackageImporter(MODEL_PATH).load_pickle("tts_models", "model")
        model.to(torch.device("cpu"))
        _silero["model"] = model
        _silero["np"] = np
        print("Silero: модель загружена", flush=True)
    return _silero["model"], _silero["np"]

def _split_text(text):
    parts, cur = [], ""
    for sent in re.split(r"(?<=[.!?…])\s+", text.strip()):
        if cur and len(cur) + len(sent) + 1 > CHUNK_LIMIT:
            parts.append(cur)
            cur = sent
        else:
            cur = f"{cur} {sent}".strip()
    if cur:
        parts.append(cur)
    return parts

def synth_silero(text, voice):
    model, np = _load_silero()
    v = voice if voice in SILERO_VOICES else "baya"
    pause = np.zeros(int(SAMPLE_RATE * 0.12), dtype=np.float32)
    chunks = []
    for part in _split_text(text):
        with _silero_lock:
            audio = model.apply_tts(text=part, speaker=v, sample_rate=SAMPLE_RATE)
        chunks.append(audio.numpy())
        chunks.append(pause)
    data = np.concatenate(chunks) if chunks else np.zeros(1, dtype=np.float32)
    pcm = np.clip(data * 32767.0, -32768, 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm.tobytes())
    return buf.getvalue(), "audio/wav"

# ── выбор движка ───────────────────────────────────────────
def synthesize(text, voice):
    if ENGINE == "silero":
        return synth_silero(text, voice)
    if ENGINE == "yandex" or (ENGINE == "auto" and YANDEX_API_KEY):
        primary = synth_yandex
    else:
        primary = synth_edge
    try:
        return primary(text, voice)
    except Exception as err:  # noqa: BLE001 — сетевой движок недоступен
        print(f"{primary.__name__} не сработал ({err}), откатываюсь на silero", flush=True)
        return synth_silero(text, voice)

# ── HTTP ───────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    def _json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "engine": ENGINE,
                             "yandex_key": bool(YANDEX_API_KEY)})
        else:
            self._json(404, {"error": "не найдено"})

    def do_POST(self):
        if self.path != "/tts":
            return self._json(404, {"error": "не найдено"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self._json(400, {"error": "некорректный JSON"})

        text = str(payload.get("text", "")).strip()[:MAX_TEXT]
        voice = str(payload.get("voice", "")).strip()
        if not text:
            return self._json(400, {"error": "текст пуст"})

        try:
            audio, ctype = synthesize(text, voice)
        except Exception as err:  # noqa: BLE001 — отдаём причину клиенту
            return self._json(500, {"error": f"ошибка синтеза: {err}"})

        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} {fmt % args}", flush=True)


if __name__ == "__main__":
    print(f"TTS: http://0.0.0.0:{PORT} (движок: {ENGINE})", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
