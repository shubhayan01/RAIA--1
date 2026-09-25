# N.O.V.A — Node app + optional Python/Playwright browser for PDF report render.
FROM node:20-bookworm-slim

# ---- System deps: Python + pip for the Playwright PDF renderer (optional) ----
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---- Python: Playwright + Chromium (only needed for Full Prospect Report PDF) ----
COPY python/requirements.txt ./python/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r python/requirements.txt \
 && python3 -m playwright install --with-deps chromium

# ---- Node deps (prod only; tsx is a runtime dependency) ----
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# ---- App source ----
COPY . .

ENV NODE_ENV=production
ENV NOVA_PYTHON=python3
# Render/other hosts inject PORT; config.ts reads NOVA_PORT || PORT (falls back to 8788).
EXPOSE 8788

CMD ["npm", "start"]
