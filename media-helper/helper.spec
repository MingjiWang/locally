# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller spec for the one-click media helper.
#
# Build (from the media-helper/ directory):
#     pip install pyinstaller
#     pyinstaller helper.spec
# Output: dist/la26v1-media-helper  (or .exe on Windows)
#
# Thin-launcher mode (default): no binaries are bundled; the launcher fetches
# yt-dlp + a static ffmpeg into a per-user cache on first run (small download,
# always-current yt-dlp).
#
# Fully-bundled mode (offline): drop `ffmpeg` (and optionally `yt-dlp`) into a
# `bundled/bin/` folder next to this spec before building; they'll be embedded
# and used ahead of any download.

import os

block_cipher = None

datas = []
here = os.path.abspath(os.getcwd())
bundled = os.path.join(here, "bundled", "bin")
if os.path.isdir(bundled):
    for fn in os.listdir(bundled):
        full = os.path.join(bundled, fn)
        if os.path.isfile(full):
            datas.append((full, "bin"))

a = Analysis(
    ["helper_launcher.py"],
    pathex=[here],
    binaries=[],
    datas=datas,
    hiddenimports=["server"],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="la26v1-media-helper",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
