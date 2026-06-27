# File Streamer

Stream files from browser to server (and back) over WebSocket — fully encrypted end-to-end. No plain text ever crosses the wire.

---

## Stack

| Side | Tech |
| --- | --- |
| Client | React + TypeScript (Vite) |
| Server | Node.js + TypeScript (`ws`) |
| Transport | WebSocket only |
| Encryption | XOR cipher with SHA-256 derived key |

---

## How It Works

### 1. Key Derivation

Both sides independently derive the same 32-byte key from the shared secret. The key is never sent over the wire.

```mermaid
flowchart LR
    A["Shared Secret"] --> B["SHA-256"] --> C["32-byte XOR Key"]

    style A fill:#1e293b,stroke:#475569,color:#e2e8f0
    style B fill:#312e81,stroke:#4338ca,color:#e2e8f0
    style C fill:#14532d,stroke:#15803d,color:#e2e8f0
```

---

### 2. Frame Protocol

Every WebSocket message starts with a **1-byte prefix** — no ambiguity between control and data frames.

```mermaid
flowchart LR
    A["0x00  PLAIN"]:::plain  --> D["Failed handshake ack only\n(client key was wrong — can't encrypt)"]
    B["0x01  CTRL"]:::ctrl   --> E["Encrypted JSON\n{ type, ...payload }"]
    C["0x02  CHUNK"]:::chunk --> F["Encrypted binary\n[4-byte offset][data]"]

    classDef plain fill:#7f1d1d,stroke:#991b1b,color:#fca5a5
    classDef ctrl  fill:#312e81,stroke:#4338ca,color:#c7d2fe
    classDef chunk fill:#14532d,stroke:#15803d,color:#86efac
```

---

### 3. Connection & Handshake

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server

    C->>S: WebSocket upgrade /ws
    C->>S: 0x01 CTRL · { HANDSHAKE, token } encrypted
    alt correct key
        S-->>C: 0x01 CTRL · { HANDSHAKE_ACK, ok:true } encrypted
        Note over C,S: All further traffic is encrypted
    else wrong key
        S-->>C: 0x00 PLAIN · { HANDSHAKE_ACK, ok:false }
        S-->>C: close()
        Note over C: Show "Invalid secret key" error
    end
```

---

### 4. Upload Flow

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server
    participant D as Disk

    loop For each file
        C->>S: 0x01 CTRL · UPLOAD_FILE_START { path, size }
        loop 64 KB chunks
            C->>S: 0x02 CHUNK · [offset][encrypted data]
        end
        C->>S: 0x01 CTRL · UPLOAD_FILE_END
        S->>D: flush writeStream
        S-->>C: 0x01 CTRL · UPLOAD_FILE_ACK
    end
```

---

### 5. Download Flow

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server
    participant D as Disk

    C->>S: 0x01 CTRL · DOWNLOAD_FILE { path }
    S->>D: createReadStream
    S-->>C: 0x01 CTRL · DOWNLOAD_FILE_START { size }
    loop 64 KB chunks
        S-->>C: 0x02 CHUNK · [offset][encrypted data]
    end
    S-->>C: 0x01 CTRL · DOWNLOAD_FILE_END
    C->>C: decrypt + merge chunks
    C->>C: write to disk (File System Access API)
```

---

### 6. Message Queue (no dropped frames)

Incoming frames are buffered in a queue the moment they arrive. Consumers pull from it asynchronously — React re-renders never cause frames to be missed.

```mermaid
flowchart LR
    A["WS onmessage\n(fires immediately)"]
    B{"waiter\nwaiting?"}
    C["resolve(frame)\ndirectly"]
    D["push to\n_queue[]"]
    E["nextFrame()\ncalled later"]
    F["shift from\n_queue[]"]

    A --> B
    B -- yes --> C
    B -- no  --> D
    E --> F

    style A fill:#1e293b,stroke:#475569,color:#e2e8f0
    style B fill:#7c3aed,stroke:#6d28d9,color:#fff
    style C fill:#14532d,stroke:#15803d,color:#e2e8f0
    style D fill:#312e81,stroke:#4338ca,color:#e2e8f0
    style E fill:#1e293b,stroke:#475569,color:#e2e8f0
    style F fill:#14532d,stroke:#15803d,color:#e2e8f0
```

---

### 7. Folder Structure Preservation

`webkitRelativePath` carries the full relative path of each file. The server recreates the same tree on disk.

```mermaid
flowchart TD
    A["User selects:\nmy-project/"]
    A --> B["my-project/src/index.ts"]
    A --> C["my-project/src/utils/helper.ts"]
    A --> D["my-project/package.json"]
    B --> E["received/my-project/src/index.ts"]
    C --> F["received/my-project/src/utils/helper.ts"]
    D --> G["received/my-project/package.json"]

    style A fill:#1e293b,stroke:#475569,color:#e2e8f0
    style B fill:#312e81,stroke:#4338ca,color:#e2e8f0
    style C fill:#312e81,stroke:#4338ca,color:#e2e8f0
    style D fill:#312e81,stroke:#4338ca,color:#e2e8f0
    style E fill:#14532d,stroke:#15803d,color:#e2e8f0
    style F fill:#14532d,stroke:#15803d,color:#e2e8f0
    style G fill:#14532d,stroke:#15803d,color:#e2e8f0
```

---

### 8. Download All — One Folder Picker

When downloading all files, the browser shows **one** folder picker. All files then save silently into the chosen folder with the original subfolder structure restored — no per-file save dialogs.

| Browser | Behavior |
| --- | --- |
| Chrome / Edge 86+ | ✅ One folder picker → silent saves |
| Safari 15.2+ | ✅ One folder picker → silent saves |
| Firefox | ⚠ Falls back to per-file save dialog |

---

## Event Types

| Type | Direction | Purpose |
| --- | --- | --- |
| `HANDSHAKE` | C → S | Initial auth with token |
| `HANDSHAKE_ACK` | S → C | Auth result |
| `LIST_FILES` | C → S | Request file list |
| `FILES_LIST` | S → C | Array of relative paths |
| `UPLOAD_FILE_START` | C → S | Begin file upload `{ path, size }` |
| `UPLOAD_FILE_END` | C → S | File upload complete |
| `UPLOAD_FILE_ACK` | S → C | Server confirmed save |
| `DOWNLOAD_FILE` | C → S | Request a file `{ path }` |
| `DOWNLOAD_FILE_START` | S → C | File incoming `{ size }` |
| `DOWNLOAD_FILE_END` | S → C | File transfer complete |
| `ERROR` | S → C | Error with `{ message }` |

---

## Project Structure

```text
file-streamer/
├── client/
│   ├── src/
│   │   ├── App.tsx                    # UI — key gate, upload tab, download tab
│   │   └── services/
│   │       └── fileStreamService.ts   # Crypto, frame protocol, WS queue
│   ├── vite.config.ts                 # Proxy /ws → localhost:3001
│   └── package.json
│
└── server/
    ├── src/
    │   └── index.ts                   # WS server — handshake, upload, download
    ├── received/                      # Uploaded files land here
    └── package.json
```

---

## Running

crate a `.env` file under `stream-server` add env variables ( refer `.env.sample` )

```bash
# Server
cd stream-server
pnpm install
pnpm run dev

# Client
cd stream-client
pnpm install
pnpm run dev
# Open http://localhost:5173 — enter "mysecret" as the key
```

---

## Security Notes

| Property | Detail |
| --- | --- |
| Encryption | XOR with SHA-256 key — simple, not production-grade |
| Key exchange | Never transmitted — both sides derive independently |
| All frames encrypted | Control messages, chunks, and acks — all XOR'd |
| Path traversal | Server strips `../` before writing to disk |
| Upgrade for production | Replace XOR with AES-256-GCM (`SubtleCrypto` / `crypto.createCipheriv`) |
