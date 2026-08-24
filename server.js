// HTTP-сервер без внешних зависимостей: статика из public/ + REST API рекламаций.
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const store = require("./db");

const PORT = Number(process.env.PORT) || 3012;
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8"
};

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function validate(payload, { requireText }) {
  const errors = [];
  const out = {};
  for (const key of ["text", "problem", "level", "status"]) {
    const v = payload[key];
    if (v === undefined) continue;
    if (typeof v !== "string") {
      errors.push(`поле «${key}» должно быть строкой`);
      continue;
    }
    out[key] = v.trim().slice(0, 4000);
  }
  if ((requireText && out.text === undefined) || (out.text !== undefined && !out.text)) {
    errors.push("текст рекламации не может быть пустым");
  }
  return { errors, out };
}

async function handleApi(req, res, url) {
  const m = url.pathname.match(/^\/api\/reklamations(?:\/(\d+))?$/);
  if (!m) return sendJson(res, 404, { error: "не найдено" });
  const id = m[1] ? Number(m[1]) : null;

  if (req.method === "GET" && id === null) return sendJson(res, 200, await store.list());

  if (req.method === "POST" && id === null) {
    const { errors, out } = validate(await readBody(req), { requireText: true });
    if (errors.length) return sendJson(res, 400, { error: errors.join("; ") });
    return sendJson(res, 201, await store.create(out));
  }

  if (req.method === "PUT" && id !== null) {
    const { errors, out } = validate(await readBody(req), { requireText: false });
    if (errors.length) return sendJson(res, 400, { error: errors.join("; ") });
    const row = await store.update(id, out);
    return row ? sendJson(res, 200, row) : sendJson(res, 404, { error: "рекламация не найдена" });
  }

  if (req.method === "DELETE" && id !== null) {
    return (await store.remove(id))
      ? sendJson(res, 200, { ok: true })
      : sendJson(res, 404, { error: "рекламация не найдена" });
  }

  return sendJson(res, 405, { error: "метод не поддерживается" });
}

function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("404");
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return serveStatic(res, url.pathname);
  } catch (err) {
    const clientFault = err.message === "invalid JSON" || err.message === "body too large";
    return sendJson(res, clientFault ? 400 : 500, { error: err.message });
  }
});

async function start() {
  const attempts = 15;
  for (let i = 1; i <= attempts; i++) {
    try {
      await store.init();
      server.listen(PORT, () => {
        console.log(`Рекламации: http://localhost:${PORT}`);
      });
      return;
    } catch (err) {
      if (i === attempts) {
        console.error("Не удалось подключиться к PostgreSQL:", err.message);
        console.error("Проверьте DATABASE_URL или переменные PGHOST/PGUSER/PGPASSWORD/PGDATABASE.");
        process.exit(1);
      }
      console.log(`PostgreSQL ещё не готов (${err.message}), попытка ${i}/${attempts}…`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

start();
