# Playwright image already has Chromium + system deps + ffmpeg-friendly base
FROM mcr.microsoft.com/playwright:v1.61.1-jammy


# Install ffmpeg for compositing
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts

COPY . .

ENV NODE_ENV=production
CMD ["node", "index.js"]
