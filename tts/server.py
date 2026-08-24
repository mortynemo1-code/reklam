# Сервис озвучки: Silero TTS (v4_ru) за простым HTTP API.
# POST /tts {"text": "...", "voice": "baya"} -> audio/wav (48 кГц, mono)
# GET  /health -> {"ok": true}
import io
import json
import os
import re
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import torch

MODEL_PATH = os.environ.get("MODEL_PATH", "/app/v4_ru.pt")
PORT = int(os.environ.get("PORT", "5002"))
SAMPLE_RATE = 48000
MAX_TEXT = 4200
CHUNK_LIMIT = 800  # символов на один вызов модели

torch.set_num_threads(int(os.environ.get("TTS_THREADS", "4")))
model = torch.package.PackageImporter(MODEL_PATH).load_pickle("tts_models", "model")
model.to(torch.device("cpu"))
VOICES = [s for s in model.speakers if s != "random"]
model_lock = threading.Lock()
print(f"Модель загружена, голоса: {', '.join(VOICES)}", flush=True)


def split_text(text):
    """Режем длинный текст по предложениям, чтобы не упереться в лимит модели."""
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


def synth_wav(text, voice):
    pause = np.zeros(int(SAMPLE_RATE * 0.12), dtype=np.float32)
    chunks = []
    for part in split_text(text):
        with model_lock:
            audio = model.apply_tts(text=part, speaker=voice, sample_rate=SAMPLE_RATE)
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
    return buf.getvalue()


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
            self._json(200, {"ok": True, "voices": VOICES})
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
        voice = str(payload.get("voice", "baya"))
        if not text:
            return self._json(400, {"error": "текст пуст"})
        if voice not in VOICES:
            return self._json(400, {"error": f"нет голоса «{voice}», доступны: {', '.join(VOICES)}"})

        try:
            wav = synth_wav(text, voice)
        except Exception as err:  # noqa: BLE001 — отдаём причину клиенту
            return self._json(500, {"error": f"ошибка синтеза: {err}"})

        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav)))
        self.end_headers()
        self.wfile.write(wav)

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} {fmt % args}", flush=True)


if __name__ == "__main__":
    print(f"TTS: http://0.0.0.0:{PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
