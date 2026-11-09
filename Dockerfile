FROM node:22-bookworm-slim

# Python + yt-dlp (kèm curl_cffi để giả trình duyệt, bắt buộc cho TikTok)
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir -U "yt-dlp[default,curl-cffi]"

ENV PATH="/opt/venv/bin:$PATH" \
    YTDLP="yt-dlp" \
    NODE_ENV=production \
    PORT=3000

WORKDIR /app
COPY api-server.js ./
COPY public ./public

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "api-server.js"]
