import { useRef, useState } from "react";
import { streamFiles } from "./services/fileStreamService";

type Status = "idle" | "streaming" | "done" | "error";

const primaryBtn =
  "flex-1 rounded-lg bg-indigo-600 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed";

const secondaryBtn =
  "flex-1 rounded-lg border border-gray-700 bg-gray-800 py-2.5 text-sm font-semibold text-white transition hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed";

export default function App() {
  const [secret, setSecret] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState({ done: 0, total: 0, current: "" });
  const [error, setError] = useState("");
  const folderRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleStream(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    if (!secret.trim()) {
      setError("Enter a secret first.");
      return;
    }
    setError("");
    setStatus("streaming");

    try {
      await streamFiles(fileList, secret, (done, total, current) => {
        setProgress({ done, total, current });
      });
      setStatus("done");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setStatus("error");
    }
  }

  const pct =
    progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : 0;

  return (
  <div className="min-h-screen bg-[#0f1117] flex items-center justify-center font-sans">
    <div className="w-105 rounded-2xl border border-[#2a2d3e] bg-[#1a1d27] p-10 shadow-[0_8px_40px_rgba(0,0,0,0.5)]">

      <h1 className="m-0 text-2xl font-bold text-[#e8eaf6]">
        File Streamer
      </h1>

      <p className="mt-1 mb-6 text-[13px] text-gray-500">
        Stream files to server — encrypted in transit
      </p>

      <label className="mb-1.5 block text-xs text-gray-400">
        Shared Secret
      </label>

      <input
        type="password"
        placeholder="Enter secret key…"
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        disabled={status === "streaming"}
        className="
          mb-5 w-full rounded-lg border border-gray-700
          bg-gray-900 px-3.5 py-2.5 text-sm text-gray-200
          outline-none
          focus:border-indigo-500
          focus:ring-2 focus:ring-indigo-500/20
          disabled:cursor-not-allowed
          disabled:opacity-50
        "
      />

      <div className="mb-5 flex gap-3">

        {/* Folder Picker */}
        <input
          ref={folderRef}
          type="file"
          className="hidden"
          // @ts-ignore
          webkitdirectory=""
          multiple
          onChange={(e) => handleStream(e.target.files)}
        />

        <button
          onClick={() => folderRef.current?.click()}
          disabled={status === "streaming"}
          className={primaryBtn}
        >
          📁 Select Folder
        </button>

        {/* File Picker */}
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          multiple
          onChange={(e) => handleStream(e.target.files)}
        />

        <button
          onClick={() => fileRef.current?.click()}
          disabled={status === "streaming"}
          className={secondaryBtn}
        >
          📄 Select Files
        </button>
      </div>

      {status === "streaming" && (
        <div className="mt-2">
          <div className="mb-2 h-1.5 overflow-hidden rounded bg-gray-700">
            <div
              className="h-full bg-indigo-600 transition-all duration-200"
              style={{ width: `${pct}%` }}
            />
          </div>

          <p className="break-all text-xs text-gray-400">
            {progress.done}/{progress.total} —{" "}
            {decodeURIComponent(progress.current)}
          </p>
        </div>
      )}

      {status === "done" && (
        <p className="mt-2 text-sm text-emerald-400">
          ✅ All {progress.total} file(s) streamed!
        </p>
      )}

      {error && (
        <p className="mt-2 text-sm text-red-400">
          ⚠ {error}
        </p>
      )}

    </div>
  </div>
);;
}