#!/usr/bin/env python3
"""
Local companion helper for the L.A26V1 Browser Kit "Extract" tab.

Why this exists
---------------
Downloading public streaming media needs three things the browser sandbox
forbids: raw sockets, a real `ffmpeg` binary, and cross-origin fetches.
This tiny server runs on the USER's own machine (or their own VPS), so it
has all three. The web page stays hosted and browser-only; it just talks to
this helper over http://127.0.0.1:<port>.

It is a thin, honest wrapper around `yt-dlp` (which itself calls `ffmpeg`
to stitch HLS/DASH segments). No extractor logic is reimplemented here.

Requirements (on the machine that runs THIS file):
  - Python 3.8+
  - yt-dlp   ->  pip install -U yt-dlp
  - ffmpeg   ->  system package (apt install ffmpeg / brew install ffmpeg)

Run:
  python3 server.py                 # binds 127.0.0.1:8765
  python3 server.py --port 9000
  python3 server.py --host 0.0.0.0 --token MYSECRET   # for a VPS, behind auth

Endpoints (all send permissive CORS headers so the hosted page can call them):
  GET /health                       -> { ok, ytdlp, ffmpeg }
  GET /info?url=...                 -> { title, duration, thumbnail, ext, filesize }
  GET /extract?url=...&mode=audio   -> streams the media file back
        mode = audio (default) | video
        format = (audio only) container passthrough by default; set
                 format=wav|mp3|flac to force a transcode via ffmpeg.

This file has no third-party Python dependencies; it only shells out to
yt-dlp and ffmpeg.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# --------------------------------------------------------------------------
# Config (populated from CLI in main())
# --------------------------------------------------------------------------
CONFIG = {
    "token": None,          # optional shared secret; required as ?token= if set
    "allow_origin": "*",    # CORS Access-Control-Allow-Origin value
}

AUDIO_TRANSCODE = {
    "wav": ("wav", "audio/wav"),
    "mp3": ("mp3", "audio/mpeg"),
    "flac": ("flac", "audio/flac"),
    "m4a": ("m4a", "audio/mp4"),
    "opus": ("opus", "audio/ogg"),
}

CONTENT_TYPES = {
    ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".opus": "audio/ogg",
    ".ogg": "audio/ogg", ".oga": "audio/ogg", ".wav": "audio/wav",
    ".flac": "audio/flac", ".aac": "audio/aac", ".webm": "video/webm",
    ".mp4": "video/mp4", ".mkv": "video/x-matroska", ".mov": "video/quicktime",
}


def which(binary):
    return shutil.which(binary)


def ytdlp_version():
    exe = which("yt-dlp")
    if not exe:
        return None
    try:
        out = subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=15)
        return out.stdout.strip() or None
    except Exception:
        return None


def safe_name(name):
    base = re.sub(r"[^\w\-. ]+", "", name or "").strip().replace(" ", "_")
    return base or "media"


class Handler(BaseHTTPRequestHandler):
    server_version = "MediaHelper/1.0"

    # -- small helpers -----------------------------------------------------
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", CONFIG["allow_origin"])
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self, params):
        if not CONFIG["token"]:
            return True
        return params.get("token", [None])[0] == CONFIG["token"]

    def log_message(self, fmt, *args):
        sys.stderr.write("[helper] " + (fmt % args) + "\n")

    # -- routing -----------------------------------------------------------
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        route = parsed.path.rstrip("/") or "/"
        params = urllib.parse.parse_qs(parsed.query)

        if route == "/health":
            return self._health()
        if not self._authorized(params):
            return self._json(401, {"error": "unauthorized (bad or missing token)"})
        if route == "/info":
            return self._info(params)
        if route == "/extract":
            return self._extract(params)
        return self._json(404, {"error": f"unknown route {route}"})

    # -- endpoints ---------------------------------------------------------
    def _health(self):
        self._json(200, {
            "ok": bool(which("yt-dlp") and which("ffmpeg")),
            "ytdlp": ytdlp_version(),
            "ffmpeg": bool(which("ffmpeg")),
            "auth": bool(CONFIG["token"]),
        })

    def _info(self, params):
        url = (params.get("url", [""])[0] or "").strip()
        if not url:
            return self._json(400, {"error": "missing url"})
        exe = which("yt-dlp")
        if not exe:
            return self._json(500, {"error": "yt-dlp not installed"})
        try:
            out = subprocess.run(
                [exe, "-J", "--no-warnings", "--no-playlist", url],
                capture_output=True, text=True, timeout=90,
            )
            if out.returncode != 0:
                return self._json(502, {"error": "yt-dlp failed", "detail": out.stderr[-800:]})
            meta = json.loads(out.stdout)
            self._json(200, {
                "title": meta.get("title"),
                "duration": meta.get("duration"),
                "thumbnail": meta.get("thumbnail"),
                "ext": meta.get("ext"),
                "filesize": meta.get("filesize") or meta.get("filesize_approx"),
                "extractor": meta.get("extractor_key"),
                "is_live": meta.get("is_live", False),
            })
        except subprocess.TimeoutExpired:
            self._json(504, {"error": "info timed out"})
        except Exception as e:
            self._json(500, {"error": str(e)})

    def _extract(self, params):
        url = (params.get("url", [""])[0] or "").strip()
        mode = (params.get("mode", ["audio"])[0] or "audio").lower()
        fmt = (params.get("format", [""])[0] or "").lower()
        if not url:
            return self._json(400, {"error": "missing url"})
        exe = which("yt-dlp")
        if not exe:
            return self._json(500, {"error": "yt-dlp not installed"})
        if not which("ffmpeg"):
            return self._json(500, {"error": "ffmpeg not installed"})

        tmpdir = tempfile.mkdtemp(prefix="mediahelper_")
        out_tmpl = os.path.join(tmpdir, "%(title).80s.%(ext)s")
        cmd = [exe, "--no-warnings", "--no-playlist", "--restrict-filenames", "-o", out_tmpl]

        if mode == "video":
            # Best combined video+audio, muxed to mp4 for broad browser support.
            cmd += ["-f", "bv*+ba/b", "--merge-output-format", "mp4"]
        else:
            # Audio-first (the default for this kit): grab bestaudio.
            cmd += ["-f", "ba/bestaudio/best"]
            if fmt in AUDIO_TRANSCODE:
                target_ext, _ = AUDIO_TRANSCODE[fmt]
                cmd += ["-x", "--audio-format", target_ext]

        cmd.append(url)

        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
        except subprocess.TimeoutExpired:
            shutil.rmtree(tmpdir, ignore_errors=True)
            return self._json(504, {"error": "download timed out"})
        except Exception as e:
            shutil.rmtree(tmpdir, ignore_errors=True)
            return self._json(500, {"error": str(e)})

        if proc.returncode != 0:
            shutil.rmtree(tmpdir, ignore_errors=True)
            return self._json(502, {"error": "yt-dlp failed", "detail": proc.stderr[-1200:]})

        files = [os.path.join(tmpdir, f) for f in os.listdir(tmpdir)]
        files = [f for f in files if os.path.isfile(f)]
        if not files:
            shutil.rmtree(tmpdir, ignore_errors=True)
            return self._json(500, {"error": "no output file produced"})
        # Pick the largest file (the real media, not a .part or thumbnail).
        path = max(files, key=os.path.getsize)
        fname = safe_name(os.path.basename(path))
        ext = os.path.splitext(path)[1].lower()
        ctype = CONTENT_TYPES.get(ext, "application/octet-stream")
        size = os.path.getsize(path)

        try:
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(size))
            self.send_header("Content-Disposition", f'attachment; filename="{fname}"')
            self.send_header("X-Media-Name", fname)
            self.send_header("Access-Control-Expose-Headers", "X-Media-Name, Content-Disposition")
            self._cors()
            self.end_headers()
            with open(path, "rb") as fh:
                shutil.copyfileobj(fh, self.wfile, length=1024 * 256)
        except (BrokenPipeError, ConnectionResetError):
            self.log_message("client disconnected during stream")
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


def run_server(host="127.0.0.1", port=8765, token=None, allow_origin="*"):
    """Start the helper. Importable so the one-click launcher can call it
    directly (after it has ensured yt-dlp/ffmpeg are on PATH)."""
    CONFIG["token"] = token
    CONFIG["allow_origin"] = allow_origin

    missing = [b for b in ("yt-dlp", "ffmpeg") if not which(b)]
    if missing:
        sys.stderr.write(
            "WARNING: missing on PATH: " + ", ".join(missing) + "\n"
            "  yt-dlp:  pip install -U yt-dlp\n"
            "  ffmpeg:  apt install ffmpeg  |  brew install ffmpeg\n"
            "The server will still start, but /extract will error until these exist.\n\n"
        )

    httpd = ThreadingHTTPServer((host, port), Handler)
    sys.stderr.write(
        f"[helper] listening on http://{host}:{port}  "
        f"(yt-dlp={ytdlp_version() or 'MISSING'}, ffmpeg={'ok' if which('ffmpeg') else 'MISSING'})\n"
        f"[helper] auth={'on' if CONFIG['token'] else 'off'}  origin={CONFIG['allow_origin']}\n"
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        sys.stderr.write("\n[helper] shutting down\n")
        httpd.shutdown()


def main():
    ap = argparse.ArgumentParser(description="Local media-extract companion (yt-dlp + ffmpeg).")
    ap.add_argument("--host", default="127.0.0.1", help="bind host (default 127.0.0.1)")
    ap.add_argument("--port", type=int, default=8765, help="bind port (default 8765)")
    ap.add_argument("--token", default=None, help="optional shared secret required as ?token=")
    ap.add_argument("--allow-origin", default="*", help="CORS allow-origin (default *)")
    args = ap.parse_args()
    run_server(args.host, args.port, args.token, args.allow_origin)


if __name__ == "__main__":
    main()
