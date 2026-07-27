FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    HOME=/home/agentify \
    AGENTIFY_DESKTOP_CHROME_BIN=/app/docker/chrome-wrapper.sh \
    AGENTIFY_DESKTOP_CHROME_PROFILE_MODE=isolated \
    DISPLAY=:99

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      xvfb \
      x11vnc \
      novnc \
      websockify \
      ca-certificates \
      dumb-init \
      fonts-liberation \
      fonts-noto-color-emoji \
      procps \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 10001 --shell /bin/bash agentify

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

RUN chmod +x \
      /app/docker/entrypoint.sh \
      /app/docker/chrome-wrapper.sh \
    && mkdir -p \
      /home/agentify/.agentify-desktop \
      /workspace/input \
      /workspace/output \
      /workspace/config \
    && chown -R agentify:agentify \
      /app \
      /home/agentify \
      /workspace

USER agentify

EXPOSE 6080

ENTRYPOINT ["dumb-init", "--", "/app/docker/entrypoint.sh"]
CMD ["node", "run-batch.mjs", "--config", "/workspace/config/batch.config.json", "--headless"]
