FROM node:20-slim

ENV NODE_ENV=production

# Install ffmpeg from apt (stable) + curl + certs
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# App setup
WORKDIR /app

# Install deps first (cache-friendly)
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copy the rest
COPY . .

# Render provides PORT; server reads process.env.PORT
EXPOSE 8080
CMD ["node", "server.js"]
