# File Streamer

A encrypted file streaming app — select a folder or files in the browser, and they stream directly to the server over WebSocket, encrypted end-to-end. No plain text ever leaves the client.

---

## Stack

| Side | Tech |
|---|---|
| Client | React + TypeScript (Vite) |
| Server | Node.js + TypeScript (`ws`) |
| Transport | WebSocket |
| Encryption | XOR cipher with SHA-256 derived key |

---

## How It Works

### 1. Key Derivation

Both client and server independently derive the same 32-byte key from the shared secret. They never exchange the key over the wire.

```mermaid
flowchart LR
    A["Shared Secret\n(e.g. 'mysecret')"]
    B["SHA-256 Hash"]
    C["32-byte XOR Key"]

    A --> B --> C

    style A fill:#1e293b,stroke:#475569,color:#e2e8f0
    style B fill:#312e81,stroke:#4338ca,color:#e2e8f0
    style C fill:#14532d,stroke:#15803d,color:#e2e8f0
```

---

### 2. XOR Encryption

Each byte of data is XORed against the key at a rolling offset. XOR is symmetric — the same operation encrypts and decrypts.

```mermaid
flowchart LR
    A["Plain byte\n0x48 'H'"]
    B["Key byte\n0xA3 at offset i"]
    C["XOR ⊕"]
    D["Encrypted byte\n0xEB"]
    E["XOR ⊕"]
    F["Plain byte\n0x48 'H'"]

    A --> C
    B --> C
    C --> D
    D --> E
    B --> E
    E --> F

    style A fill:#1e293b,stroke:#475569,color:#e2e8f0
    style B fill:#312e81,stroke:#4338ca,color:#e2e8f0
    style C fill:#7c3aed,stroke:#6d28d9,color:#fff
    style D fill:#7f1d1d,stroke:#991b1b,color:#e2e8f0
    style E fill:#7c3aed,stroke:#6d28d9,color:#fff
    style F fill:#14532d,stroke:#15803d,color:#e2e8f0
```

---

### 3. Full Stream Flow (per file)

```mermaid
sequenceDiagram
    participant U as User
    participant C as Client (React)
    participant V as Vite Proxy
    participant S as Server (Node)
    participant D as Disk

    U->>C: Select folder / files + enter secret
    C->>C: SHA-256(secret) → 32-byte key

    C->>V: WebSocket upgrade /ws
    V->>S: Forward upgrade
    S-->>C: Connection open

    loop For each file
        C->>C: Encrypt JSON metadata<br/>{"type":"file","path":"...","size":...}
        C->>S: send() → encrypted binary blob

        loop 64 KB chunks
            C->>C: Read chunk from file.stream()
            C->>C: XOR encrypt chunk (rolling offset)
            C->>S: send() → encrypted binary blob
        end

        C->>C: Encrypt {"type":"end"}
        C->>S: send() → encrypted binary blob

        S->>S: Decrypt → detect "end"
        S->>D: writeStream.end() → flush to disk
        S->>C: send() → encrypted {"type":"ok","path":"..."}
        C->>C: Decrypt ack → move to next file
    end

    C->>S: ws.close()
    C->>U: ✅ Done
```

---

### 4. Folder Structure Preservation

The browser's `webkitRelativePath` gives the full relative path of each file inside the selected folder. The server recreates the same tree on disk.

```mermaid
flowchart TD
    A["User selects folder:\nmy-project/"]

    A --> B["src/index.ts\nwebkitRelativePath:\nmy-project/src/index.ts"]
    A --> C["src/utils/helper.ts\nwebkitRelativePath:\nmy-project/src/utils/helper.ts"]
    A --> D["package.json\nwebkitRelativePath:\nmy-project/package.json"]

    B --> E["Server writes:\nreceived/my-project/src/index.ts"]
    C --> F["Server writes:\nreceived/my-project/src/utils/helper.ts"]
    D --> G["Server writes:\nreceived/my-project/package.json"]

    style A fill:#1e293b,stroke:#475569,color:#e2e8f0
    style B fill:#312e81,stroke:#4338ca,color:#e2e8f0
    style C fill:#312e81,stroke:#4338ca,color:#e2e8f0
    style D fill:#312e81,stroke:#4338ca,color:#e2e8f0
    style E fill:#14532d,stroke:#15803d,color:#e2e8f0
    style F fill:#14532d,stroke:#15803d,color:#e2e8f0
    style G fill:#14532d,stroke:#15803d,color:#e2e8f0
```

---

### 5. Message Protocol

Every frame sent over WebSocket is an encrypted binary blob — no plain text at any point.

```mermaid
flowchart TD
    A["WebSocket frame received"]
    B["XOR decrypt with KEY at offset 0"]
    C{"Valid JSON?\ntype = file or end?"}
    D["Control: file\nOpen writeStream\nReset byteOffset"]
    E["Control: end\nFlush writeStream\nSend encrypted ack"]
    F["File chunk\nXOR decrypt at byteOffset\nWrite to stream\nbyteOffset += chunk.length"]

    A --> B --> C
    C -- Yes --> D & E
    C -- No --> F

    style A fill:#1e293b,stroke:#475569,color:#e2e8f0
    style B fill:#312e81,stroke:#4338ca,color:#e2e8f0
    style C fill:#7c3aed,stroke:#6d28d9,color:#fff
    style D fill:#14532d,stroke:#15803d,color:#e2e8f0
    style E fill:#14532d,stroke:#15803d,color:#e2e8f0
    style F fill:#7f1d1d,stroke:#991b1b,color:#e2e8f0
```

---

## Project Structure

```
file-streamer/
├── client/
│   ├── src/
│   │   ├── App.tsx                    # UI — file picker, progress, status
│   │   └── services/
│   │       └── fileStreamService.ts   # Key derivation, XOR, WS streaming
│   ├── vite.config.ts                 # Proxy /ws → localhost:3001
│   └── package.json
│
└── server/
    ├── src/
    │   └── index.ts                   # WS server, decrypt, write to disk
    ├── received/                      # Streamed files land here
    └── package.json
```

---

## Running

```bash
# 1. Start server
cd server
npm install
SECRET=mysecret npx ts-node src/index.ts

# 2. Start client (separate terminal)
cd client
npm install
npm run dev

# 3. Open http://localhost:5173
#    Enter "mysecret" as the secret
#    Select a folder or files → stream
```

---

## Security Notes

| Property | Detail |
|---|---|
| Encryption | XOR with SHA-256 derived key — simple, not production-grade |
| Key exchange | Never transmitted — both sides derive from shared secret |
| Control frames | Also encrypted — no plain JSON visible on the wire |
| Path traversal | Server strips `../` sequences before writing to disk |
| Upgrade for production | Replace XOR with AES-256-GCM (`SubtleCrypto` / `crypto.createCipheriv`) |