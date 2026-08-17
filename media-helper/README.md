# Media Helper (local companion)

The **Extract** tab in the browser kit is a pure frontend. It can't download
streaming media by itself, because the browser blocks the three things a
downloader needs: raw sockets, a real `ffmpeg` binary, and cross-origin
fetches.

This helper runs on **your own machine** (or your own VPS) and supplies all
three. It's a thin wrapper around [`yt-dlp`](https://github.com/yt-dlp/yt-dlp)
— which already handles URL discovery, stream stitching (via `ffmpeg`), and
site-specific quirks. Nothing is reimplemented here, and nothing is sent to a
server the kit's author controls.

Think of it like the `.onnx` model you drop into the Transcribe tab: **you**
bring the runtime; the web UI just drives it.

> Scope: public, non-DRM media only. It does **not** and cannot decrypt paid
> or DRM-protected streams. Respect each site's Terms of Service and copyright.

---

## Easiest: the one-click app (no terminal)

Grab the binary for your OS from the project's **Releases** page and double-click it:

| OS | File | First-launch note |
|----|------|-------------------|
| macOS | `la26v1-media-helper-macos` | Unsigned build: **right-click → Open** once to bypass Gatekeeper |
| Windows | `la26v1-media-helper-windows.exe` | SmartScreen: **More info → Run anyway** |
| Linux | `la26v1-media-helper-linux` | `chmod +x` then run |

On first run it downloads `yt-dlp` and a static `ffmpeg` into a small per-user
cache (needs internet once), then starts the helper on `127.0.0.1:8765`. Leave
the window open and use the **Extract** tab. Close the window to stop it.

The launcher reads a few optional environment variables: `HELPER_PORT`,
`HELPER_TOKEN`, `KIT_URL` (opened in the browser on launch),
`HELPER_NO_DOWNLOAD=1` (only use bundled/PATH tools), and `HELPER_CACHE_DIR`.

### Build the one-click app yourself

Binaries are produced per-OS (you can't cross-compile). Either push a
`helper-v*` tag to run `.github/workflows/build-helper.yml` (builds macOS +
Windows + Linux and attaches them to a Release), or build locally:

```bash
cd media-helper
pip install pyinstaller
pyinstaller helper.spec          # -> dist/la26v1-media-helper
```

By default it's a *thin launcher* (tools fetched on first run). To make a
fully-offline binary, drop `ffmpeg` (and optionally `yt-dlp`) into
`media-helper/bundled/bin/` before building and they'll be embedded.

---

## Or run from source

## Requirements

- **Python 3.8+**
- **yt-dlp** — `pip install -U yt-dlp`
- **ffmpeg** — `apt install ffmpeg` (Linux) / `brew install ffmpeg` (macOS) / [ffmpeg.org](https://ffmpeg.org/download.html) (Windows)

## Run it (local, recommended)

```bash
pip install -U yt-dlp          # once
python3 server.py              # binds http://127.0.0.1:8765
```

Leave it running, then open the kit and use the **Extract** tab. It auto-detects
the helper on `127.0.0.1:8765`.

Custom port:

```bash
python3 server.py --port 9000
```

## Run it on your own VPS

Expose it to your other devices, protected by a shared secret:

```bash
python3 server.py --host 0.0.0.0 --port 8765 --token CHANGE_ME
```

Then in the Extract tab, point the helper URL at
`http://YOUR_VPS_IP:8765` and enter the token.

## Run it with Docker

```bash
docker build -t media-helper ./media-helper
docker run --rm -p 8765:8765 media-helper
```

---

## API

All responses include permissive CORS headers so the hosted page can call them.

| Route | Method | Purpose |
|-------|--------|---------|
| `/health` | GET | `{ ok, ytdlp, ffmpeg, auth }` — used for auto-detection |
| `/info?url=…` | GET | title / duration / thumbnail (from `yt-dlp -J`) |
| `/extract?url=…&mode=audio\|video[&format=wav]` | GET | streams the media file back |

- **`mode=audio`** (default): `yt-dlp -f ba/bestaudio` — fast, small, no video
  pulled. Container is passed through untranscoded unless you set `format=`.
- **`mode=video`**: `yt-dlp -f bv*+ba/b --merge-output-format mp4`.
- **`format=wav|mp3|flac|m4a|opus`** (audio only): forces a `ffmpeg` transcode.
  Usually unnecessary — the browser decodes `m4a`/`webm`/`opus` natively for the
  Transform tab.
- **`token`**: required as `?token=…` on `/info` and `/extract` when the server
  was started with `--token`.

## Notes

- Keep `yt-dlp` current — sites change often: `pip install -U yt-dlp`.
- Binds to `127.0.0.1` by default (only your machine can reach it). Use
  `--host 0.0.0.0` **only** with `--token`.
- One `/extract` call = one `yt-dlp` run into a temp dir; the file is streamed
  back and the temp dir is deleted.
