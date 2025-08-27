# mp4-clipper/Dockerfile
FROM node:20-slim

# Install tools + fetch a stable static FFmpeg (includes libx264/aac)
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils \
  && rm -rf /var/lib/apt/lists/*

# Download linux64 static FFmpeg and place binaries in PATH
RUN set -eux; \
  curl -sL https://johnvansickle.com/ffmpeg/builds/ffmpeg-git-amd64-static.tar.xz \
  | tar -xJ && \
  mv ffmpeg-*-amd64-static/ffmpeg /usr/local/bin/ffmpeg && \
  mv ffmpeg-*-amd64-static/ffprobe /usr/local/bin/ffprobe && \
  chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe && \
  rm -rf ffmpeg-*-amd64-static

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

EXPOSE 8080
CMD ["node", "server.js"]
