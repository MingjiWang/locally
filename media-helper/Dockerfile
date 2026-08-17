# Local companion helper for the Extract tab.
# Bundles yt-dlp + ffmpeg so a user can run the extractor on their own box
# (laptop or a personal VPS) instead of a server you host.
#
# Build:  docker build -t media-helper ./media-helper
# Run:    docker run --rm -p 8765:8765 media-helper
#   VPS:  docker run --rm -p 8765:8765 media-helper \
#             python3 server.py --host 0.0.0.0 --token CHANGE_ME
FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -U -r requirements.txt
COPY server.py ./

EXPOSE 8765
# Default binds 0.0.0.0 inside the container so the published port works.
CMD ["python3", "server.py", "--host", "0.0.0.0", "--port", "8765"]
