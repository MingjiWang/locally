#!/usr/bin/env python3
"""
One-click launcher for the media helper.

This is the entry point PyInstaller freezes into a double-clickable binary so
non-technical users don't touch a terminal. It:

  1. Makes sure `yt-dlp` and `ffmpeg` are available, in this order:
       a) bundled next to the binary (PyInstaller _MEIPASS/bin),
       b) already on the system PATH,
       c) a per-user cache (~/.la26v1-helper/bin) — downloading them there
          on first run if missing ("thin launcher": keeps the download small
          and yt-dlp always current).
  2. Prepends those locations to PATH so the server's shutil.which() finds them.
  3. Opens the kit in the browser (if a KIT_URL is configured).
  4. Starts the local helper server (server.run_server).

Config via environment (all optional):
  HELPER_HOST   (default 127.0.0.1)
  HELPER_PORT   (default 8765)
  HELPER_TOKEN  (default none)
  KIT_URL       (if set, opened in the browser on launch)
  HELPER_NO_DOWNLOAD=1   (never auto-download; only use bundled/PATH tools)
"""

import io
import os
import platform
import shutil
import stat
import sys
import tarfile
import time
import urllib.request
import webbrowser
import zipfile

APP_NAME = "la26v1-helper"

# yt-dlp standalone binaries (always latest).
YTDLP_URLS = {
    ("Darwin", "*"): "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos",
    ("Windows", "*"): "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe",
    ("Linux", "aarch64"): "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64",
    ("Linux", "*"): "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux",
}

# ffmpeg static builds (stable "latest" URLs). These are archives; we extract
# the ffmpeg binary out of them.
FFMPEG_URLS = {
    ("Darwin", "*"): "https://evermeet.cx/ffmpeg/getrelease/zip",
    ("Windows", "*"): "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip",
    ("Linux", "aarch64"): "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-linuxarm64-gpl.tar.xz",
    ("Linux", "*"): "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-linux64-gpl.tar.xz",
}


def is_windows():
    return platform.system() == "Windows"


def exe(name):
    return name + ".exe" if is_windows() else name


def pick(url_map):
    system = platform.system()
    machine = platform.machine().lower()
    for (sys_key, mach_key), url in url_map.items():
        if sys_key != system:
            continue
        if mach_key == "*" or mach_key.lower() == machine:
            return url
    # fall back to wildcard for this system
    return url_map.get((system, "*"))


def cache_bin_dir():
    """Directory for downloaded tools. Returns None if it can't be created
    (the launcher then degrades gracefully instead of crashing)."""
    override = os.environ.get("HELPER_CACHE_DIR")
    try:
        if override:
            d = os.path.join(override, "bin")
        elif is_windows():
            base = os.environ.get("LOCALAPPDATA", os.path.expanduser("~"))
            d = os.path.join(base, APP_NAME, "bin")
        else:
            d = os.path.join(os.path.expanduser("~"), "." + APP_NAME, "bin")
        os.makedirs(d, exist_ok=True)
        return d
    except Exception as e:
        print(f"[launcher] cache dir unavailable ({e}); skipping local cache")
        return None


def bundled_dir():
    # PyInstaller onefile unpacks datas into sys._MEIPASS.
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, "bin")


def make_executable(path):
    try:
        st = os.stat(path)
        os.chmod(path, st.st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    except Exception:
        pass


def download(url, timeout=120):
    req = urllib.request.Request(url, headers={"User-Agent": APP_NAME})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def fetch_ytdlp(dest_dir):
    url = pick(YTDLP_URLS)
    if not url:
        return None
    out = os.path.join(dest_dir, exe("yt-dlp"))
    print(f"[launcher] downloading yt-dlp …")
    data = download(url)
    with open(out, "wb") as f:
        f.write(data)
    make_executable(out)
    return out


def _extract_ffmpeg_from_zip(data, dest_path):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for name in z.namelist():
            base = os.path.basename(name)
            if base in ("ffmpeg", "ffmpeg.exe"):
                with z.open(name) as src, open(dest_path, "wb") as dst:
                    shutil.copyfileobj(src, dst)
                return True
    return False


def _extract_ffmpeg_from_tar(data, dest_path):
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:xz") as t:
        for member in t.getmembers():
            if member.isfile() and os.path.basename(member.name) == "ffmpeg":
                src = t.extractfile(member)
                with open(dest_path, "wb") as dst:
                    shutil.copyfileobj(src, dst)
                return True
    return False


def fetch_ffmpeg(dest_dir):
    url = pick(FFMPEG_URLS)
    if not url:
        return None
    out = os.path.join(dest_dir, exe("ffmpeg"))
    print(f"[launcher] downloading ffmpeg (this can take a minute) …")
    data = download(url, timeout=300)
    ok = False
    if url.endswith(".tar.xz"):
        ok = _extract_ffmpeg_from_tar(data, out)
    else:
        ok = _extract_ffmpeg_from_zip(data, out)
    if not ok:
        raise RuntimeError("could not find ffmpeg inside the downloaded archive")
    make_executable(out)
    return out


def ensure_tool(name, fetch_fn, allow_download):
    """Return a directory that contains `name`, searching bundled → PATH →
    cache, downloading into the cache if needed and allowed."""
    fname = exe(name)

    bd = bundled_dir()
    if os.path.exists(os.path.join(bd, fname)):
        make_executable(os.path.join(bd, fname))
        return bd

    on_path = shutil.which(name)
    if on_path:
        return os.path.dirname(on_path)

    cache = cache_bin_dir()
    if cache and os.path.exists(os.path.join(cache, fname)):
        make_executable(os.path.join(cache, fname))
        return cache

    if not allow_download or not cache:
        return None

    try:
        got = fetch_fn(cache)
        if got:
            return cache
    except Exception as e:
        print(f"[launcher] could not auto-download {name}: {e}")
    return None


def main():
    host = os.environ.get("HELPER_HOST", "127.0.0.1")
    port = int(os.environ.get("HELPER_PORT", "8765"))
    token = os.environ.get("HELPER_TOKEN") or None
    kit_url = os.environ.get("KIT_URL", "").strip()
    allow_download = os.environ.get("HELPER_NO_DOWNLOAD", "") not in ("1", "true", "yes")

    print(f"[launcher] {APP_NAME} starting on {platform.system()} / {platform.machine()}")

    dirs = []
    for name, fetch in (("ffmpeg", fetch_ffmpeg), ("yt-dlp", fetch_ytdlp)):
        d = ensure_tool(name, fetch, allow_download)
        if d:
            dirs.append(d)
            print(f"[launcher] {name}: {os.path.join(d, exe(name))}")
        else:
            print(f"[launcher] {name}: NOT AVAILABLE — /extract will error until it is installed")

    # Prepend discovered dirs so server's shutil.which() finds the tools.
    if dirs:
        os.environ["PATH"] = os.pathsep.join(dirs + [os.environ.get("PATH", "")])

    # Import the server only after PATH is set up.
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    try:
        from server import run_server
    except Exception:
        import server  # frozen bundle keeps them side by side
        run_server = server.run_server

    if kit_url:
        try:
            print(f"[launcher] opening {kit_url}")
            webbrowser.open(kit_url)
        except Exception:
            pass
    else:
        print("[launcher] open your kit and go to the Extract tab.")

    print(f"[launcher] helper ready at http://{host}:{port}  (press Ctrl+C or close this window to stop)")
    try:
        run_server(host=host, port=port, token=token, allow_origin="*")
    except KeyboardInterrupt:
        pass
    except OSError as e:
        print(f"[launcher] could not start server on {host}:{port}: {e}")
        print("[launcher] is another copy already running? This window will stay open.")
        try:
            time.sleep(10)
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
