FROM node:20-slim

ENV NODE_ENV=production

# Tools + fetch a stable static FFmpeg (includes x264/aac)
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  curl -sL https://johnvansickle.com/ffmpeg/builds/ffmpeg-git-amd64-static.tar.xz \
  | tar -xJ && \
  mv ffmpeg-*-amd64-static/ffmpeg /usr/local/bin/ffmpeg && \
  mv ffmpeg-*-amd64-static/ffprobe /usr/local/bin/ffprobe && \
  chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe && \
  rm -rf ffmpeg-*-amd64-static

# Set working directory inside the container
WORKDIR /app

# Install dependencies first (use lockfile if present)
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copy the rest of the app
COPY . .

# Render provides PORT, your code already reads process.env.PORT
EXPOSE 8080
CMD ["node", "server.js"]
