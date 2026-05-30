// Minimal zero-dependency static file server for local development.
// Mic access requires a secure context; localhost counts as secure, so this
// works for testing the app without any HTTPS setup.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = process.env.PORT || 5173;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (urlPath === "/") urlPath = "/index.html";
    // Prevent path traversal.
    const filePath = join(ROOT, normalize(urlPath).replace(/^(\.\.[/\\])+/, ""));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const data = await readFile(filePath);
    res.writeHead(200, { "Content-Type": TYPES[extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
});

// If the preferred port is taken, fall back to an OS-assigned free port
// (unless PORT was set explicitly, in which case respect the user's choice).
const portWasExplicit = process.env.PORT != null;

server.on("error", (err) => {
  if (err.code === "EADDRINUSE" && !portWasExplicit) {
    console.warn(`Port ${PORT} is in use — picking a free port instead…`);
    server.listen(0);
  } else {
    console.error(err.message);
    process.exit(1);
  }
});

server.listen(PORT, () => {
  const { port } = server.address();
  console.log(`Intonation running at http://localhost:${port}`);
});
