#!/usr/bin/env node
// API tải video TikTok, dùng yt-dlp phía dưới. Node.js >= 18, không cần thư viện ngoài.
//
// Chạy:   node api-server.js
// Biến môi trường (tuỳ chọn):
//   PORT=3000                 cổng HTTP
//   YTDLP="python -m yt_dlp"  lệnh gọi yt-dlp (mặc định thử python -m yt_dlp)
//   MAX_JOBS=3                số tiến trình yt-dlp chạy cùng lúc
//
// Endpoint:
//   GET /api/health
//   GET /api/info?url=<tiktok_url>                 -> JSON metadata + danh sách định dạng
//   GET /api/download?url=<tiktok_url>[&format=b]  -> stream file mp4 về client

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PUBLIC_DIR = path.join(__dirname, "public");
// Link iCloud của phím tắt iPhone (tạo 1 lần trên iPhone rồi "Sao chép liên kết iCloud")
const SHORTCUT_URL = process.env.SHORTCUT_URL || "";

const PORT = Number(process.env.PORT) || 3000;
const MAX_JOBS = Number(process.env.MAX_JOBS) || 3;
const JOB_TIMEOUT_MS = 5 * 60 * 1000;
const [YTDLP_BIN, ...YTDLP_PREFIX] = (process.env.YTDLP || "python -m yt_dlp").split(" ");

const ALLOWED_HOSTS = new Set([
  "tiktok.com", "www.tiktok.com", "m.tiktok.com", "vm.tiktok.com", "vt.tiktok.com",
]);
// Chỉ cho phép ký tự an toàn trong chuỗi chọn định dạng của yt-dlp
const FORMAT_RE = /^[\w\-+\/\[\]=<>!^$*~.:,]{1,100}$/;

let running = 0;

// ---------- tiện ích ----------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function validateUrl(raw) {
  if (!raw) throw httpError(400, "Thiếu tham số url");
  let u;
  try { u = new URL(raw); } catch { throw httpError(400, "url không hợp lệ"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw httpError(400, "Chỉ hỗ trợ http/https");
  if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) throw httpError(400, "Chỉ hỗ trợ link tiktok.com");
  return u.href;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function lastErrorLine(stderr) {
  const lines = stderr.trim().split(/\r?\n/);
  return lines.reverse().find((l) => l.startsWith("ERROR")) || lines[0] || "yt-dlp lỗi không rõ";
}

// Chạy yt-dlp, args luôn là mảng (không qua shell) và URL đứng sau "--" để chống chèn tham số
function runYtdlp(args, url) {
  if (running >= MAX_JOBS) throw httpError(429, "Server đang bận, thử lại sau");
  running++;
  const child = spawn(YTDLP_BIN, [...YTDLP_PREFIX, "--no-playlist", "--no-progress", ...args, "--", url], {
    windowsHide: true,
  });
  let done = false;
  const finish = () => { if (!done) { done = true; running--; clearTimeout(timer); } };
  const timer = setTimeout(() => child.kill(), JOB_TIMEOUT_MS);
  child.on("close", finish);
  child.on("error", finish);
  return child;
}

// ---------- /api/info ----------
function handleInfo(url, res) {
  const child = runYtdlp(["-J"], url);
  let out = "", err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  child.on("error", (e) => sendJson(res, 500, { error: `Không chạy được yt-dlp: ${e.message}` }));
  child.on("close", (code) => {
    if (res.headersSent) return;
    if (code !== 0) return sendJson(res, 502, { error: lastErrorLine(err) });
    let info;
    try { info = JSON.parse(out); } catch { return sendJson(res, 502, { error: "yt-dlp trả về JSON lỗi" }); }

    sendJson(res, 200, {
      id: info.id,
      title: info.title,
      description: info.description,
      uploader: info.uploader,
      channel: info.channel,
      timestamp: info.timestamp,
      upload_date: info.upload_date,
      duration: info.duration,
      view_count: info.view_count,
      like_count: info.like_count,
      thumbnail: info.thumbnail,
      webpage_url: info.webpage_url,
      best_format_id: info.format_id,
      formats: (info.formats || []).map((f) => ({
        format_id: f.format_id,
        ext: f.ext,
        width: f.width,
        height: f.height,
        vcodec: f.vcodec,
        acodec: f.acodec,
        filesize: f.filesize,
        note: f.format_note,
        url: f.url, // link CDN, có thời hạn; cần gửi kèm http_headers + cookies khi tải
        http_headers: f.http_headers,
        cookies: f.cookies,
      })),
    });
  });
}

// ---------- /api/download ----------
function handleDownload(url, format, req, res) {
  const child = runYtdlp(["-f", format, "-o", "-"], url);
  let err = "";
  let started = false;

  const m = url.match(/\/video\/(\d+)/);
  const isAudio = format.startsWith("audio");
  const filename = `tiktok_${m ? m[1] : Date.now()}.${isAudio ? "mp3" : "mp4"}`;

  child.stderr.on("data", (d) => (err += d));
  child.stdout.on("data", (chunk) => {
    // Chỉ gửi header khi đã có dữ liệu, để nếu yt-dlp lỗi thì vẫn trả được JSON lỗi
    if (!started) {
      started = true;
      res.writeHead(200, {
        "Content-Type": isAudio ? "audio/mpeg" : "video/mp4",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Access-Control-Allow-Origin": "*",
      });
    }
    if (!res.write(chunk)) {
      child.stdout.pause();
      res.once("drain", () => child.stdout.resume());
    }
  });
  child.on("error", (e) => {
    if (!started) sendJson(res, 500, { error: `Không chạy được yt-dlp: ${e.message}` });
  });
  child.on("close", (code) => {
    if (!started) return res.headersSent || sendJson(res, 502, { error: lastErrorLine(err) });
    res.end();
    if (code !== 0) console.error(`[download] yt-dlp thoát mã ${code}: ${lastErrorLine(err)}`);
  });
  // Client huỷ giữa chừng -> dừng yt-dlp
  res.on("close", () => { if (!res.writableFinished) child.kill(); });
}

// ---------- router ----------
const server = http.createServer((req, res) => {
  const t0 = Date.now();
  res.on("finish", () => console.log(`${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - t0}ms)`));

  try {
    const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET" });
      return res.end();
    }
    if (req.method !== "GET") throw httpError(405, "Chỉ hỗ trợ GET");

    switch (u.pathname) {
      case "/":
      case "/index.html":
        return fs.readFile(path.join(PUBLIC_DIR, "index.html"), (err, html) => {
          if (err) return sendJson(res, 500, { error: "Thiếu public/index.html" });
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
          res.end(html);
        });
      case "/api/config":
        return sendJson(res, 200, { shortcutUrl: SHORTCUT_URL });
      case "/api/health":
        return sendJson(res, 200, { ok: true, running, maxJobs: MAX_JOBS });
      case "/api/info":
        return handleInfo(validateUrl(u.searchParams.get("url")), res);
      case "/api/download": {
        const format = u.searchParams.get("format") || "b";
        if (!FORMAT_RE.test(format)) throw httpError(400, "format không hợp lệ");
        return handleDownload(validateUrl(u.searchParams.get("url")), format, req, res);
      }
      default:
        throw httpError(404, "Không tìm thấy endpoint");
    }
  } catch (e) {
    sendJson(res, e.status || 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`TikTok API chạy tại http://localhost:${PORT}`);
  console.log(`yt-dlp: ${[YTDLP_BIN, ...YTDLP_PREFIX].join(" ")}`);
});
