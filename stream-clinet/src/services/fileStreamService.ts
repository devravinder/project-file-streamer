const CHUNK_SIZE = 64 * 1024;

async function deriveKey(secret: string): Promise<Uint8Array> {
  const encoded = new TextEncoder().encode(secret);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  return new Uint8Array(hashBuffer);
}

function xorChunk(chunk: Uint8Array, key: Uint8Array, offset: number): Uint8Array {
  const out = new Uint8Array(chunk.length);
  for (let i = 0; i < chunk.length; i++) {
    out[i] = chunk[i] ^ key[(offset + i) % key.length];
  }
  return out;
}

// Encrypt a JSON control message → send as binary (not text)
function encryptText(text: string, key: Uint8Array) {
  const bytes = new TextEncoder().encode(text);
  const encrypted = xorChunk(bytes, key, 0);
  return encrypted.buffer.slice(0) as BufferSource // .slice(0) gives a plain ArrayBuffer, not SharedArrayBuffer
}

function waitForMessage(ws: WebSocket, key: Uint8Array): Promise<unknown> {
  return new Promise((resolve, reject) => {
    ws.addEventListener(
      "message",
      async (e: MessageEvent) => {
        // Server acks are now encrypted binary blobs
        const buffer = await (e.data as Blob).arrayBuffer();
        const decrypted = xorChunk(new Uint8Array(buffer), key, 0);
        const text = new TextDecoder().decode(decrypted);
        try{
          resolve(JSON.parse(text))
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        }catch(_){
             // if invalid key....plain message
             const text = new TextDecoder().decode(new Uint8Array(buffer));
             resolve(JSON.parse(text))
        }
        ;
      },
      { once: true }
    );
    ws.addEventListener("error", () => reject(new Error("WebSocket error")), {
      once: true,
    });
  });
}
const HANDSHAKE = "FILE_STREAMER_HANDSHAKE";

export async function streamFiles(
  fileList: FileList,
  secret: string,
  onProgress: (done: number, total: number, current: string) => void
): Promise<void> {
  const key = await deriveKey(secret);
  const files = Array.from(fileList);

  const ws = new WebSocket(`ws://${location.host}/ws`);
  // All messages are binary — no plain text ever leaves the client
  ws.binaryType = "blob";

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("Cannot connect to server")), { once: true });
  });

    // ── Verify key ──
  ws.send(encryptText(HANDSHAKE, key));
  const ack = await waitForMessage(ws, key) as { type: string; ok: boolean };
  if (!ack.ok) throw new Error("Invalid secret key"); // caught in App.tsx → shows error
  // ────────────────

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const relativePath = file.webkitRelativePath || file.name;
    onProgress(i, files.length, relativePath);

    // 1. Send encrypted file metadata (binary, not plain JSON)
    ws.send(encryptText(JSON.stringify({ type: "file", path: relativePath, size: file.size }), key));

    // 2. Stream encrypted file chunks
    let offset = 0;
    while (offset < file.size) {
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      const buffer = await slice.arrayBuffer();
      const chunk = new Uint8Array(buffer);
      const encrypted = xorChunk(chunk, key, offset);
      ws.send(encrypted.buffer.slice(0) as BufferSource);  // same fix
      offset += chunk.length;
    }

    // 3. Send encrypted end signal, wait for encrypted ack
    ws.send(encryptText(JSON.stringify({ type: "end" }), key));
    const ack = await waitForMessage(ws, key) as { type: string; message?: string };
    if (ack.type === "error") throw new Error(ack.message ?? "Server error");
  }

  ws.close();
  onProgress(files.length, files.length, "");
}

//===
export async function downloadFiles(
  secret: string,
  onProgress: (done: number, total: number, current: string) => void
): Promise<void> {
  const key = await deriveKey(secret);

  // 1. Fetch file list
  const res = await fetch("/api/list");
  const files: string[] = await res.json();

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    onProgress(i, files.length, filePath);

    // 2. Download encrypted file
    const r = await fetch(`/api/download?path=${encodeURIComponent(filePath)}`);
    const buffer = await r.arrayBuffer();

    // 3. Decrypt
    const decrypted = xorChunk(new Uint8Array(buffer), key, 0);

    // 4. Save with folder structure using File System Access API
    const parts = filePath.split(/[\\/]/);
    const blob = new Blob([decrypted as unknown as ArrayBuffer]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = parts[parts.length - 1]; // browser only saves flat — see note
    a.click();
    URL.revokeObjectURL(url);

    await new Promise((r) => setTimeout(r, 100)); // small delay between downloads
  }

  onProgress(files.length, files.length, "");
}