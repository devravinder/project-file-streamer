const wsUrl = import.meta.env.VITE_WS_URL || `ws://${location.host}`;

// ─── Event Types ─────────────────────────────────────────────────────────────
export const EV = {
  HANDSHAKE:           "HANDSHAKE",
  HANDSHAKE_ACK:       "HANDSHAKE_ACK",
  LIST_FILES:          "LIST_FILES",
  FILES_LIST:          "FILES_LIST",
  UPLOAD_FILE_START:   "UPLOAD_FILE_START",
  UPLOAD_FILE_END:     "UPLOAD_FILE_END",
  UPLOAD_FILE_ACK:     "UPLOAD_FILE_ACK",
  DOWNLOAD_FILE:       "DOWNLOAD_FILE",
  DOWNLOAD_FILE_START: "DOWNLOAD_FILE_START",
  DOWNLOAD_FILE_END:   "DOWNLOAD_FILE_END",
  ERROR:               "ERROR",
} as const;

// Frame prefix — first byte of every WS message
// 0x00 = plain JSON  (only for failed handshake ack — wrong key)
// 0x01 = encrypted JSON control frame
// 0x02 = encrypted binary chunk
const FRAME = { PLAIN: 0x00, CTRL: 0x01, CHUNK: 0x02 } as const;

const CHUNK_SIZE = 64 * 1024;

// ─── Crypto ───────────────────────────────────────────────────────────────────
async function deriveKey(secret: string): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return new Uint8Array(buf);
}

function xor(data: Uint8Array, key: Uint8Array, offset = 0): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i]! ^ key[(offset + i) % key.length]!;
  }
  return out;
}

// ─── Frame builders ───────────────────────────────────────────────────────────
function ctrlFrame(obj: object, key: Uint8Array): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  const enc  = xor(json, key, 0);
  const buf  = new Uint8Array(1 + enc.length);
  buf[0]     = FRAME.CTRL;
  buf.set(enc, 1);
  return buf.buffer.slice(0);
}

function chunkFrame(data: Uint8Array, key: Uint8Array, offset: number): ArrayBuffer {
  const enc = xor(data, key, offset);
  const buf = new Uint8Array(1 + 4 + enc.length);
  buf[0]    = FRAME.CHUNK;
  new DataView(buf.buffer).setUint32(1, offset, false);
  buf.set(enc, 5);
  return buf.buffer.slice(0);
}

function decodeCtrl<T>(buf: ArrayBuffer, key: Uint8Array): T {
  const enc = new Uint8Array(buf, 1);
  const dec = xor(enc, key, 0);
  return JSON.parse(new TextDecoder().decode(dec)) as T;
}

function decodeChunk(buf: ArrayBuffer, key: Uint8Array): { offset: number; data: Uint8Array } {
  const offset = new DataView(buf).getUint32(1, false);
  const enc    = new Uint8Array(buf, 5);
  return { offset, data: xor(enc, key, offset) };
}

// ─── Push-based message queue ─────────────────────────────────────────────────
// Frames arrive and are pushed into a queue immediately.
// Consumers call next() which either resolves instantly (if frame is ready)
// or waits until one arrives. No frames are ever dropped.

type QueuedFrame = ArrayBuffer;

let _ws:    WebSocket  | null = null;
let _key:   Uint8Array | null = null;
let _queue: QueuedFrame[]     = [];
let _waiters: ((f: ArrayBuffer) => void)[] = [];

function _onMessage(e: MessageEvent) {
  const toAB = (d: unknown): Promise<ArrayBuffer> =>
    d instanceof Blob ? d.arrayBuffer() : Promise.resolve(d as ArrayBuffer);

  toAB(e.data).then((buf) => {
    if (_waiters.length > 0) {
      // Hand directly to the oldest waiting consumer
      _waiters.shift()!(buf);
    } else {
      // No consumer waiting — buffer it
      _queue.push(buf);
    }
  });
}

/** Pull the next frame from the queue (or wait for one) */
function nextFrame(): Promise<ArrayBuffer> {
  if (_queue.length > 0) return Promise.resolve(_queue.shift()!);
  return new Promise((resolve) => _waiters.push(resolve));
}

/** Pull next frame and decode as control JSON */
async function nextCtrl<T>(): Promise<T> {
  const buf = await nextFrame();
  return decodeCtrl<T>(buf, key());
}

function ws():  WebSocket  { if (!_ws  || _ws.readyState !== WebSocket.OPEN) throw new Error("Not connected");  return _ws;  }
function key(): Uint8Array { if (!_key) throw new Error("Not authenticated"); return _key; }

function sendCtrl(obj: object)                        { ws().send(ctrlFrame(obj, key())); }
function sendChunk(data: Uint8Array, offset: number)  { ws().send(chunkFrame(data, key(), offset)); }

// ─── Connect + Handshake ──────────────────────────────────────────────────────
export async function connect(secret: string): Promise<void> {
  const k = await deriveKey(secret);

  if (_ws && _ws.readyState === WebSocket.OPEN) _ws.close();
  _queue   = [];
  _waiters = [];

  const sock = new WebSocket(`${wsUrl}/ws`);
  sock.binaryType = "arraybuffer"; // ← arraybuffer, not blob — avoids async Blob.arrayBuffer()

  await new Promise<void>((resolve, reject) => {
    sock.addEventListener("open",  () => resolve(),                             { once: true });
    sock.addEventListener("error", () => reject(new Error("Cannot connect")),  { once: true });
  });

  // Attach persistent queue listener BEFORE sending handshake
  sock.addEventListener("message", _onMessage);

  // Send handshake (encrypted ctrl frame)
  const hs    = new TextEncoder().encode(JSON.stringify({ type: EV.HANDSHAKE, token: "FILE_STREAMER_HANDSHAKE" }));
  const enc   = xor(hs, k, 0);
  const frame = new Uint8Array(1 + enc.length);
  frame[0]    = FRAME.CTRL;
  frame.set(enc, 1);
  sock.send(frame.buffer.slice(0));

  // Wait for ack — check prefix to decide how to decode
  const ackBuf = await nextFrame();
  const prefix = new Uint8Array(ackBuf)[0];

  let ack: { type: string; ok: boolean; message?: string };
  if (prefix === FRAME.PLAIN) {
    // Wrong key — server sent plain JSON
    ack = JSON.parse(new TextDecoder().decode(new Uint8Array(ackBuf, 1)));
  } else {
    // Correct key — server sent encrypted ack
    ack = decodeCtrl<typeof ack>(ackBuf, k);
  }

  if (!ack.ok) {
    sock.close();
    _queue = []; _waiters = [];
    throw new Error(ack.message ?? "Invalid secret key");
  }

  _ws  = sock;
  _key = k;
}

export function disconnect() {
  _ws?.removeEventListener("message", _onMessage);
  _ws?.close();
  _ws = null; _key = null; _queue = []; _waiters = [];
}

export function isConnected() {
  return !!_ws && _ws.readyState === WebSocket.OPEN && !!_key;
}

// ─── Upload ───────────────────────────────────────────────────────────────────
export async function uploadFiles(
  fileList: FileList,
  onProgress: (done: number, total: number, current: string) => void
): Promise<void> {
  const files = Array.from(fileList);

  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const rel  = file.webkitRelativePath || file.name;
    onProgress(i, files.length, rel);

    sendCtrl({ type: EV.UPLOAD_FILE_START, path: rel, size: file.size });

    let offset = 0;
    while (offset < file.size) {
      const raw = new Uint8Array(await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer());
      sendChunk(raw, offset);
      offset += raw.length;
    }

    sendCtrl({ type: EV.UPLOAD_FILE_END });
    const ack = await nextCtrl<{ type: string; message?: string }>();
    if (ack.type === EV.ERROR) throw new Error(ack.message ?? "Upload failed");
  }

  onProgress(files.length, files.length, "");
}

// ─── List files ───────────────────────────────────────────────────────────────
export async function listFiles(): Promise<string[]> {
  sendCtrl({ type: EV.LIST_FILES });
  const res = await nextCtrl<{ type: string; files: string[] }>();
  if (res.type === EV.ERROR) throw new Error("Failed to list files");
  return res.files;
}

// ─── File System Access API helper ───────────────────────────────────────────
// Gets (or creates) a nested file handle inside a root DirectoryHandle.
// e.g. "job/cv/file.pdf" → root/job/cv/file.pdf
async function getFileHandle(
  root: FileSystemDirectoryHandle,
  relativePath: string
): Promise<FileSystemFileHandle> {
  const parts = relativePath.replace(/\\/g, "/").split("/");
  const fileName = parts.pop()!;
  let dir = root;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  return dir.getFileHandle(fileName, { create: true });
}

// Write a Uint8Array directly to a FileSystemFileHandle (no save dialog)
async function writeToDisk(
  handle: FileSystemFileHandle,
  data: Uint8Array
): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(data as unknown as ArrayBuffer);
  await writable.close();
}

// ─── Receive one file from server (shared by both download functions) ─────────
async function receiveFile(
  filePath: string,
  onProgress?: (received: number, total: number) => void
): Promise<Uint8Array> {
  sendCtrl({ type: EV.DOWNLOAD_FILE, path: filePath });

  const start = await nextCtrl<{ type: string; size: number }>();
  if (start.type === EV.ERROR) throw new Error(`File not found: ${filePath}`);

  const total  = start.size;
  const chunks: Uint8Array[] = [];
  let received = 0;

  while (true) {
    const buf    = await nextFrame();
    const prefix = new Uint8Array(buf)[0];

    if (prefix === FRAME.CTRL) {
      const msg = decodeCtrl<{ type: string }>(buf, key());
      if (msg.type === EV.DOWNLOAD_FILE_END) break;
      if (msg.type === EV.ERROR) throw new Error("Download error from server");
      continue;
    }

    if (prefix === FRAME.CHUNK) {
      const { data } = decodeChunk(buf, key());
      chunks.push(data);
      received += data.length;
      onProgress?.(received, total);
    }
  }

  const merged = new Uint8Array(received);
  let pos = 0;
  for (const c of chunks) { merged.set(c, pos); pos += c.length; }
  return merged;
}

// ─── Fallback: browser save dialog (single file, no FS Access API) ────────────
function triggerBrowserSave(data: Uint8Array, filePath: string) {
  const blob = new Blob([data as unknown as ArrayBuffer]);
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement("a"), {
    href: url,
    download: filePath.split(/[\\/]/).pop() ?? filePath,
  });
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Download single file ─────────────────────────────────────────────────────
// For a single file we just trigger the browser save dialog (one dialog is fine).
export async function downloadFile(
  filePath: string,
  onProgress?: (received: number, total: number) => void
): Promise<void> {
  const data = await receiveFile(filePath, onProgress);
  triggerBrowserSave(data, filePath);
}

// ─── Download all files — one folder picker, then silent saves ────────────────
export async function downloadAllFiles(
  onProgress: (filesDone: number, filesTotal: number, current: string, bytesReceived: number, bytesTotal: number) => void
): Promise<void> {
  const files = await listFiles();
  if (files.length === 0) return;

  // Ask user to pick a destination folder — ONE dialog for all files
  let rootDir: FileSystemDirectoryHandle | null = null;
  if ("showDirectoryPicker" in window) {
    rootDir = await (window as Window & { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> })
      .showDirectoryPicker();
  }

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i]!;
    onProgress(i, files.length, filePath, 0, 0);

    const data = await receiveFile(filePath, (recv, total) =>
      onProgress(i, files.length, filePath, recv, total)
    );

    if (rootDir) {
      // Save directly into chosen folder, recreating subfolder structure — no dialog
      const handle = await getFileHandle(rootDir, filePath);
      await writeToDisk(handle, data);
    } else {
      // Fallback for browsers without File System Access API (Firefox)
      triggerBrowserSave(data, filePath);
    }
  }

  onProgress(files.length, files.length, "", 0, 0);
}