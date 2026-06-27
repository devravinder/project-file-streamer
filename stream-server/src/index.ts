import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT ?? 3001;
const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR ?? "../data");
const SECRET = process.env.SECRET ?? "my-default-secret";

// ─── Frame prefix bytes (mirror client) ──────────────────────────────────────
const FRAME = { PLAIN: 0x00, CTRL: 0x01, CHUNK: 0x02 } as const;

// ─── Event types ──────────────────────────────────────────────────────────────
const EV = {
  HANDSHAKE: "HANDSHAKE",
  HANDSHAKE_ACK: "HANDSHAKE_ACK",
  LIST_FILES: "LIST_FILES",
  FILES_LIST: "FILES_LIST",
  UPLOAD_FILE_START: "UPLOAD_FILE_START",
  UPLOAD_FILE_END: "UPLOAD_FILE_END",
  UPLOAD_FILE_ACK: "UPLOAD_FILE_ACK",
  DOWNLOAD_FILE: "DOWNLOAD_FILE",
  DOWNLOAD_FILE_START: "DOWNLOAD_FILE_START",
  DOWNLOAD_FILE_END: "DOWNLOAD_FILE_END",
  ERROR: "ERROR",
} as const;

// ─── Crypto ───────────────────────────────────────────────────────────────────
function deriveKey(secret: string): Buffer {
  return crypto.createHash("sha256").update(secret).digest();
}
const SERVER_KEY = deriveKey(SECRET);

function xor(data: Buffer, key: Buffer, offset = 0): Buffer {
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i]! ^ key[(offset + i) % key.length]!;
  }
  return out;
}

// ─── Frame builders ───────────────────────────────────────────────────────────
function ctrlFrame(obj: object, key: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(obj));
  const enc = xor(json, key, 0);
  return Buffer.concat([Buffer.from([FRAME.CTRL]), enc]);
}

function chunkFrame(data: Buffer, key: Buffer, offset: number): Buffer {
  const enc = xor(data, key, offset);
  const header = Buffer.alloc(5);
  header[0] = FRAME.CHUNK;
  header.writeUInt32BE(offset, 1);
  return Buffer.concat([header, enc]);
}

function plainFrame(obj: object): Buffer {
  // Used ONLY for failed handshake — client doesn't have a valid key yet
  const json = Buffer.from(JSON.stringify(obj));
  return Buffer.concat([Buffer.from([FRAME.PLAIN]), json]);
}

function decodeCtrl<T>(buf: Buffer, key: Buffer): T {
  const enc = buf.subarray(1); // skip prefix
  const dec = xor(enc, key, 0);
  return JSON.parse(dec.toString("utf8")) as T;
}

// ─── File helpers ─────────────────────────────────────────────────────────────
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function safePath(p: string): string {
  return path.normalize(p).replace(/^(\.\.(\/|\\|$))+/, "");
}

function getAllFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? getAllFiles(path.join(dir, e.name))
        : [path.join(dir, e.name)],
    );
}

const CLIENT_DIST = path.resolve("../stream-clinet/dist");
const isClientExist = fs.existsSync(CLIENT_DIST);
if (isClientExist) {
  console.log("📦 Serving client from:", CLIENT_DIST);
}

// ─── HTTP → WS upgrade only ───────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  // Handle preflight first — before anything else
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  //================== to serve static files =============== start
  if (isClientExist) {
    const url = req.url ?? "/";

    // WebSocket upgrade requests skip this handler entirely (handled by ws)
    // Serve static files from client/dist
    const MIME: Record<string, string> = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".ico": "image/x-icon",
      ".json": "application/json",
      ".woff2": "font/woff2",
    };

    // Resolve file path — strip query string
    const urlPath = url.split("?")[0]!;
    const filePath = path.join(CLIENT_DIST, urlPath);
    const ext = path.extname(filePath);
    const mimeType = MIME[ext] ?? "application/octet-stream";

    // Serve the file if it exists
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      res.writeHead(200, { "Content-Type": mimeType });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // SPA fallback — all unknown routes → index.html (React Router handles it)
    const indexPath = path.join(CLIENT_DIST, "index.html");
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { "Content-Type": "text/html" });
      fs.createReadStream(indexPath).pipe(res);
      return;
    }
  }

  //============= end

  res.writeHead(426, "WebSocket only");
  res.end("WebSocket only");
});

// ─── WebSocket server ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({
  server,
  path: "/ws",
  verifyClient: (_i, cb) => cb(true),
});

wss.on("connection", (ws: WebSocket) => {
  console.log("⚡ Client connected");

  let clientKey: Buffer | null = null;
  let writeStream: fs.WriteStream | null = null;
  let uploadByteOffset = 0;
  let currentPath = "";

  function send(obj: object) {
    if (!clientKey) return;
    ws.send(ctrlFrame(obj, clientKey));
  }

  ws.on("message", (raw: Buffer) => {
    const prefix = raw[0];

    // ── Handshake (before auth) ───────────────────────────────────────────
    if (!clientKey) {
      if (prefix !== FRAME.CTRL) {
        ws.send(
          plainFrame({
            type: EV.HANDSHAKE_ACK,
            ok: false,
            message: "Expected handshake",
          }),
        );
        ws.close();
        return;
      }
      try {
        const msg = decodeCtrl<{ type: string; token: string }>(
          raw,
          SERVER_KEY,
        );
        if (
          msg.type !== EV.HANDSHAKE ||
          msg.token !== "FILE_STREAMER_HANDSHAKE"
        ) {
          throw new Error("Bad token");
        }
        clientKey = SERVER_KEY;
        console.log("✅ Handshake OK");
        // Send encrypted ack — client can decrypt because key is now confirmed correct
        ws.send(ctrlFrame({ type: EV.HANDSHAKE_ACK, ok: true }, clientKey));
      } catch {
        console.log("❌ Handshake failed — wrong key");
        // Send PLAIN ack — client's key was wrong so it can't decrypt; we send plain
        ws.send(
          plainFrame({
            type: EV.HANDSHAKE_ACK,
            ok: false,
            message: "Invalid secret key",
          }),
        );
        ws.close();
      }
      return;
    }

    // ── Binary chunk (upload) ─────────────────────────────────────────────
    if (prefix === FRAME.CHUNK) {
      if (!writeStream) return;
      const offset = raw.readUInt32BE(1); // bytes 1-4
      const encData = raw.subarray(5); // byte 5+
      const decrypted = xor(encData, clientKey, offset);
      uploadByteOffset += decrypted.length;
      writeStream.write(decrypted);
      return;
    }

    // ── Control frame ────────────────────────────────────────────────────
    if (prefix !== FRAME.CTRL) return;

    let msg: { type: string; path?: string; size?: number };
    try {
      msg = decodeCtrl(raw, clientKey);
    } catch {
      send({ type: EV.ERROR, message: "Failed to decode message" });
      return;
    }

    switch (msg.type) {
      case EV.LIST_FILES: {
        const files = getAllFiles(OUTPUT_DIR).map((f) =>
          path.relative(OUTPUT_DIR, f).replace(/\\/g, "/"),
        );
        send({ type: EV.FILES_LIST, files });
        break;
      }

      case EV.UPLOAD_FILE_START: {
        const sp = safePath(msg.path ?? "unknown");
        const dest = path.join(OUTPUT_DIR, sp);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        writeStream = fs.createWriteStream(dest);
        uploadByteOffset = 0;
        currentPath = sp;
        console.log(`⬆  Receiving: ${sp}`);
        break;
      }

      case EV.UPLOAD_FILE_END: {
        if (writeStream) {
          const p = currentPath;
          writeStream.end(() => {
            console.log(`✅ Saved: ${p}`);
            send({ type: EV.UPLOAD_FILE_ACK, path: p });
          });
          writeStream = null;
        }
        break;
      }

      case EV.DOWNLOAD_FILE: {
        const sp = safePath(msg.path ?? "");
        const absPath = path.join(OUTPUT_DIR, sp);

        if (!fs.existsSync(absPath)) {
          send({ type: EV.ERROR, message: `File not found: ${sp}` });
          break;
        }

        const size = fs.statSync(absPath).size;
        send({ type: EV.DOWNLOAD_FILE_START, path: sp, size });

        const CHUNK = 64 * 1024;
        const stream = fs.createReadStream(absPath, { highWaterMark: CHUNK });
        let dlOffset = 0;

        stream.on("data", (chunk: Buffer) => {
          ws.send(chunkFrame(chunk, clientKey!, dlOffset));
          dlOffset += chunk.length;
        });
        stream.on("end", () => {
          send({ type: EV.DOWNLOAD_FILE_END, path: sp });
          console.log(`⬇  Sent: ${sp}`);
        });
        stream.on("error", (e) => send({ type: EV.ERROR, message: e.message }));
        break;
      }
    }
  });

  ws.on("close", () => {
    writeStream?.destroy();
    console.log("🔌 Disconnected");
  });
  ws.on("error", (e) => {
    console.error("WS error:", e.message);
    writeStream?.destroy();
  });
});

server.listen(PORT, () => {
  console.log(`🚀 ws://localhost:${PORT}/ws`);
  console.log(`📂 ${OUTPUT_DIR}`);
});
