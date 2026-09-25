# S.A.G.E — Node app + Python/Playwright browser for the free Google SERP.
FROM node:20-bookworm-slim

# ---- System deps: Python + pip for the Playwright SERP scraper ----
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---- Python: Playwright + Chromium (with the OS libs it needs) ----
COPY python/requirements.txt ./python/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r python/requirements.txt \
 && python3 -m playwright install --with-deps chromium

# ---- Node deps (prod only; tsx is a runtime dependency) ----
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# ---- App source ----
COPY . .

ENV NODE_ENV=production
ENV SERP_PYTHON=python3
# Render/other hosts inject PORT; server.ts reads it (falls back to 8787).
EXPOSE 8787

CMD ["npm", "start"]
