// 静态托管 dist/，并为 SPA 路由提供 index.html 回退（仅发布用，不参与业务构建）
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve("dist");
const port = Number(process.env.PORT || 3000);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    let filePath = path.join(root, urlPath);

    // 目录或不存在 → 回退 index.html（客户端路由）
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      const indexed = path.join(filePath, "index.html");
      filePath = fs.existsSync(indexed) ? indexed : path.join(root, "index.html");
    }

    // 防止路径穿越
    if (!filePath.startsWith(root)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return;
      }
      const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
      const headers = { "content-type": type };
      // Service Worker 与入口页不缓存，保证更新即时生效
      if (filePath.endsWith("sw.js") || filePath.endsWith("index.html")) {
        headers["cache-control"] = "no-cache";
      }
      res.writeHead(200, headers).end(data);
    });
  })
  .listen(port, "0.0.0.0", () => {
    console.log(`spa-server listening on 0.0.0.0:${port}`);
  });
