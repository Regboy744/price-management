FROM node:22-bookworm

# ── Install Google Chrome stable + all required system libs ──────────────
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       wget gnupg ca-certificates \
       fonts-liberation \
       libasound2 \
       libatk-bridge2.0-0 \
       libatk1.0-0 \
       libcups2 \
       libdbus-1-3 \
       libdrm2 \
       libgbm1 \
       libgtk-3-0 \
       libnspr4 \
       libnss3 \
       libx11-xcb1 \
       libxcomposite1 \
       libxdamage1 \
       libxrandr2 \
       xdg-utils \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub \
       | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] \
       http://dl.google.com/linux/chrome/deb/ stable main" \
       > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# ── Enable pnpm via corepack ────────────────────────────────────────────
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# ── Install dependencies (cached layer) ─────────────────────────────────
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ── Copy project source ─────────────────────────────────────────────────
COPY . .

# ── Initial TypeScript build ────────────────────────────────────────────
RUN pnpm build

EXPOSE 3000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["pnpm", "dev"]
