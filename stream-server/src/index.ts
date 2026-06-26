import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT ?? 3001;
const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR ?? "../data");
const SECRET = process.env.SECRET ?? "my-default-secret";

function deriveKey(secret: string): Buffer {
  return crypto.createHash("sha256").update(secret).digest();
}

const KEY = deriveKey(SECRET)!;

// 1st time xor gives encrypted => 2nd tiem xor with encrypted gives decrypted
// 3^1 = 2 => 2^1 = 3
function xorChunk(chunk: Buffer, offset: number): Buffer {
  const out = Buffer.alloc(chunk.length);
  for (let i = 0; i < chunk.length; i++) {
    out[i] = chunk[i]! ^ KEY[(offset + i) % KEY.length]!;
  }
  return out;
}

// Encrypt/decrypt a control message (offset 0, independent per message)
function xorText(chunk: Buffer): Buffer {
  return xorChunk(chunk, 0);
}

// Try to parse decrypted bytes as JSON control message
function tryParseControl(
  data: Buffer,
): { type: string; path?: string; size?: number } | null {
  try {
    const decrypted = xorText(data);
    const text = decrypted.toString("utf8");
    const parsed = JSON.parse(text);
    // Must have a known type field to be a control message
    if (parsed.type === "file" || parsed.type === "end") return parsed;
    return null;
  } catch {
    return null;
  }
}

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const server = http.createServer((req, res) => {
  // Allow all origins for HTTP requests
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  //==

  const url = new URL(req.url!, `http://localhost:${PORT}`);

  // Returns JSON list of all files recursively
  if (url.pathname === "/api/list") {
    const files = getAllFiles(OUTPUT_DIR).map((f) =>
      path.relative(OUTPUT_DIR, f)
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(files));
    return;
  }

  // Streams a single encrypted file
  if (url.pathname === "/api/download") {
    const filePath = decodeURIComponent(url.searchParams.get("path") ?? "");
    const safePath = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, "");
    const absPath = path.join(OUTPUT_DIR, safePath);

    if (!fs.existsSync(absPath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    res.writeHead(200, { "Content-Type": "application/octet-stream" });

    let byteOffset = 0;
    const readStream = fs.createReadStream(absPath);
    readStream.on("data", (chunk: Buffer) => {
      const encrypted = xorChunk(chunk, byteOffset);
      byteOffset += chunk.length;
      res.write(encrypted);
    });
    readStream.on("end", () => res.end());
    return;
  }

  //===

  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({
  server,
  path: "/ws",
  // Allow all origins for WebSocket upgrades
  verifyClient: ({ origin }, cb) => {
    cb(true); // accept all origins
  },
});

const HANDSHAKE = "FILE_STREAMER_HANDSHAKE";
wss.on("connection", (ws: WebSocket) => {
  console.log("Client connected");
  let verified = false;

  let writeStream: fs.WriteStream | null = null;
  let byteOffset = 0;
  let currentPath = "";
  let expectingFileChunks = false;

  ws.on("message", (data: Buffer) => {

    if (!verified) {
      console.log("Veryfing...")
      try {
        const decrypted = xorText(data).toString("utf8");
        if (decrypted !== HANDSHAKE) throw new Error("Bad key");
        verified = true;
        console.log("verification success")
        ws.send(xorText(Buffer.from(JSON.stringify({ type: "handshake", ok: true }))));
      } catch {
        console.log("verification failed")
        ws.send(Buffer.from(JSON.stringify({ type: "handshake", ok: false }))); // plain — client may have wrong key
        // ws.close();
      }
      return;
    }

    // Try control message first (file | end)
    const control = tryParseControl(data);

    if (control?.type === "file") {
      const safePath = path
        .normalize(control.path ?? "unknown")
        .replace(/^(\.\.(\/|\\|$))+/, "");

      currentPath = safePath;
      const destPath = path.join(OUTPUT_DIR, safePath);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });

      writeStream = fs.createWriteStream(destPath);
      byteOffset = 0;
      expectingFileChunks = true;
      console.log(`Receiving: ${safePath}`);
      return;
    }

    if (control?.type === "end") {
      expectingFileChunks = false;
      if (writeStream) {
        writeStream.end(() => {
          console.log(`✅ Saved: ${currentPath}`);
          // Send encrypted ack
          const ack = xorText(
            Buffer.from(JSON.stringify({ type: "ok", path: currentPath })),
          );
          ws.send(ack);
        });
        writeStream = null;
      }
      return;
    }

    // Not a control message → it's an encrypted file chunk
    if (expectingFileChunks && writeStream) {
      const decrypted = xorChunk(data, byteOffset);
      byteOffset += data.length;
      writeStream.write(decrypted);
    }
  });

  ws.on("close", () => {
    writeStream?.destroy();
    console.log("Client disconnected");
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server on http://localhost:${PORT}`);
  console.log(`📂 Output: ${OUTPUT_DIR}`);
});

//===
function getAllFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((e) =>
    e.isDirectory()
      ? getAllFiles(path.join(dir, e.name))
      : [path.join(dir, e.name)]
  );
}
