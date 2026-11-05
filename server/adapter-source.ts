// Python HTTP adapter run inside the plugin's own virtualenv. It loads Supertonic once and
// answers Paseo's OpenAI-compatible /v1/audio/speech calls. Paseo asks for "pcm", which it plays
// as 24 kHz 16-bit mono, while Supertonic renders 44.1 kHz, so the adapter resamples.
// Keep this free of backticks and dollar-brace sequences: it is a template literal.
export const ADAPTER_SOURCE = String.raw`
import json
import os
import re
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

PCM_RATE = 24000
HOST = "127.0.0.1"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 47788
MODEL = sys.argv[2] if len(sys.argv) > 2 else "supertonic-3"

state = {"phase": "loading", "message": "Načítavam model Supertonic", "voices": []}
config = {"voice": "F1", "lang": "na", "speed": 1.05, "steps": 8}
ready = threading.Event()
synth_lock = threading.Lock()
tts = None
styles = {}


def log(message):
    print(message, flush=True)


def load_model():
    global tts
    try:
        from supertonic import TTS

        log("Loading Supertonic model " + MODEL + " (first run downloads about 400 MB)")
        tts = TTS(model=MODEL, auto_download=True)
        state["voices"] = sorted(tts.voice_style_names)
        state["phase"] = "ready"
        state["message"] = "Pripravené"
        log("Supertonic ready at " + str(tts.sample_rate) + " Hz, voices: " + ", ".join(state["voices"]))
    except Exception as error:
        state["phase"] = "error"
        state["message"] = "Model sa nepodarilo načítať: " + str(error)
        traceback.print_exc()
    finally:
        ready.set()


def voice_style(name):
    if name not in styles:
        styles[name] = tts.get_voice_style(voice_name=name)
    return styles[name]


MARKDOWN = re.compile(r"[*_#>~|]+")


def clean_text(text):
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = text.replace(chr(96), "")
    text = MARKDOWN.sub(" ", text)
    ok, unsupported = tts.model.text_processor.validate_text(text)
    if not ok:
        text = "".join(" " if ch in unsupported else ch for ch in text)
    return re.sub(r"\s+", " ", text).strip()


def synthesize(text, voice=None, lang=None, speed=None, steps=None):
    if not ready.wait(timeout=600):
        raise RuntimeError("Model sa stále načítava")
    if state["phase"] != "ready":
        raise RuntimeError(state["message"])
    text = clean_text(text)
    if not text:
        return np.zeros(0, dtype=np.float32), tts.sample_rate
    name = voice if voice in state["voices"] else config["voice"]
    with synth_lock:
        wav, _ = tts.synthesize(
            text,
            voice_style=voice_style(name),
            total_steps=int(steps or config["steps"]),
            speed=float(speed or config["speed"]),
            lang=lang or config["lang"],
        )
    return np.asarray(wav, dtype=np.float32).reshape(-1), tts.sample_rate


def resample(samples, source_rate, target_rate):
    if source_rate == target_rate or samples.size == 0:
        return samples
    target_len = int(round(samples.size * target_rate / source_rate))
    spectrum = np.fft.rfft(samples)
    out = np.fft.irfft(spectrum[: target_len // 2 + 1], target_len)
    return (out * (target_len / samples.size)).astype(np.float32)


def to_pcm16(samples):
    return (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


def to_wav(samples, rate):
    import io
    import wave

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(to_pcm16(samples))
    return buffer.getvalue()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def send_body(self, status, body, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status, payload):
        self.send_body(status, json.dumps(payload).encode("utf-8"), "application/json")

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        if self.path.rstrip("/") in ("/health", "/v1/health"):
            self.send_json(200, {**state, "config": config, "model": MODEL})
        elif self.path.rstrip("/") == "/v1/models":
            self.send_json(200, {"object": "list", "data": [{"id": MODEL, "object": "model"}]})
        else:
            self.send_json(404, {"error": {"message": "Not found"}})

    def do_POST(self):
        try:
            payload = self.read_json()
            path = self.path.rstrip("/")
            if path == "/shutdown":
                self.send_json(200, {"ok": True})
                threading.Thread(target=lambda: os._exit(0), daemon=True).start()
            elif path == "/config":
                for key in ("voice", "lang", "speed", "steps"):
                    if payload.get(key) is not None:
                        config[key] = payload[key]
                self.send_json(200, {"config": config})
            elif path == "/v1/audio/speech":
                text = str(payload.get("input") or "")
                fmt = str(payload.get("response_format") or "wav").lower()
                samples, rate = synthesize(text, payload.get("voice"), payload.get("lang"))
                if fmt == "pcm":
                    self.send_body(200, to_pcm16(resample(samples, rate, PCM_RATE)), "audio/pcm")
                else:
                    self.send_body(200, to_wav(samples, rate), "audio/wav")
            else:
                self.send_json(404, {"error": {"message": "Not found"}})
        except Exception as error:
            traceback.print_exc()
            self.send_json(500, {"error": {"message": str(error), "type": "server_error"}})


def exit_with_parent(parent):
    # The plugin host stops this process on cleanup; if the host dies first, follow it.
    import time

    while True:
        time.sleep(2)
        if os.getppid() != parent:
            os._exit(0)


if __name__ == "__main__":
    threading.Thread(target=exit_with_parent, args=(os.getppid(),), daemon=True).start()
    threading.Thread(target=load_model, daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    log("Supertonic adapter listening on http://" + HOST + ":" + str(PORT))
    server.serve_forever()
`;
