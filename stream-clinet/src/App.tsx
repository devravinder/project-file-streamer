import { useRef, useState, useEffect } from "react";
import {
  connect, disconnect,
  uploadFiles, listFiles, downloadFile, downloadAllFiles,
} from "./services/fileStreamService";

type Tab = "upload" | "download";
type DlMode = null | "all" | "pick";

export default function App() {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const [secret, setSecret]       = useState("");
  const [authState, setAuthState] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [authError, setAuthError] = useState("");

  // ── Tab ───────────────────────────────────────────────────────────────────
  const [tab, setTab] = useState<Tab>("upload");

  // ── Upload ────────────────────────────────────────────────────────────────
  const [uploading, setUploading]   = useState(false);
  const [uploadDone, setUploadDone] = useState(false);
  const [uploadErr, setUploadErr]   = useState("");
  const [upProg, setUpProg]         = useState({ done: 0, total: 0, current: "" });
  const folderRef                   = useRef<HTMLInputElement>(null);
  const fileRef                     = useRef<HTMLInputElement>(null);

  // ── Download ──────────────────────────────────────────────────────────────
  const [dlMode, setDlMode]           = useState<DlMode>(null);
  const [fileList, setFileList]       = useState<string[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [listErr, setListErr]         = useState("");
  const [downloading, setDownloading] = useState<string | null>(null);
  const [dlProg, setDlProg]           = useState({ files: 0, filesTotal: 0, bytes: 0, bytesTotal: 0, current: "" });
  const [dlErr, setDlErr]             = useState("");
  const [dlDone, setDlDone]           = useState(false);

  useEffect(() => () => disconnect(), []);

  // ── Auth ──────────────────────────────────────────────────────────────────
  async function handleConnect() {
    if (!secret.trim()) return;
    setAuthState("loading");
    setAuthError("");
    try {
      await connect(secret);
      setAuthState("ok");
    } catch (e) {
      setAuthState("error");
      setAuthError(e instanceof Error ? e.message : "Connection failed");
    }
  }

  function handleDisconnect() {
    disconnect();
    setAuthState("idle");
    setSecret("");
    setFileList([]);
    setDlMode(null);
    setUploadDone(false);
  }

  // ── Upload ────────────────────────────────────────────────────────────────
  async function handleUpload(fl: FileList | null) {
    if (!fl?.length) return;
    setUploading(true); setUploadDone(false); setUploadErr("");
    try {
      await uploadFiles(fl, (done, total, current) => setUpProg({ done, total, current }));
      setUploadDone(true);
    } catch (e) {
      setUploadErr(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  // ── Download all ──────────────────────────────────────────────────────────
  async function handleDownloadAll() {
    setDlMode("all"); setDlDone(false); setDlErr("");
    setDlProg({ files: 0, filesTotal: 0, bytes: 0, bytesTotal: 0, current: "" });
    try {
      await downloadAllFiles((filesDone, filesTotal, current, bytes, bytesTotal) =>
        setDlProg({ files: filesDone, filesTotal, bytes, bytesTotal, current })
      );
      setDlDone(true);
    } catch (e) {
      setDlErr(e instanceof Error ? e.message : "Download failed");
    }
  }

  // ── Pick & download ───────────────────────────────────────────────────────
  async function handleOpenPicker() {
    setDlMode("pick"); setListErr(""); setFileList([]);
    setLoadingList(true);
    try {
      setFileList(await listFiles());
    } catch (e) {
      setListErr(e instanceof Error ? e.message : "Could not load files");
    } finally {
      setLoadingList(false);
    }
  }

  async function handleDownloadOne(p: string) {
    setDownloading(p); setDlErr("");
    setDlProg({ files: 0, filesTotal: 1, bytes: 0, bytesTotal: 0, current: p });
    try {
      await downloadFile(p, (bytes, bytesTotal) =>
        setDlProg({ files: 0, filesTotal: 1, bytes, bytesTotal, current: p })
      );
    } catch (e) {
      setDlErr(e instanceof Error ? e.message : "Download failed");
    } finally {
      setDownloading(null);
    }
  }

  const upPct  = upProg.total  > 0 ? Math.round((upProg.done  / upProg.total)  * 100) : 0;
  const dlBPct = dlProg.bytesTotal > 0 ? Math.round((dlProg.bytes / dlProg.bytesTotal) * 100) : 0;
  const dlFPct = dlProg.filesTotal > 0 ? Math.round((dlProg.files / dlProg.filesTotal) * 100) : 0;

  // ── Key screen ────────────────────────────────────────────────────────────
  if (authState !== "ok") {
    return (
      <div className="min-h-screen bg-[#0a0b0f] flex items-center justify-center">
        <div className="w-96 rounded-2xl border border-white/[0.07] bg-[#13151c] p-8 shadow-2xl">
          <div className="mb-7">
            <h1 className="text-xl font-bold text-white tracking-tight">File Streamer</h1>
            <p className="text-xs text-gray-500 mt-1">Enter your secret key to continue</p>
          </div>

          <label className="block text-[11px] font-medium text-gray-500 uppercase tracking-wider mb-2">
            Secret Key
          </label>
          <input
            type="password"
            placeholder="••••••••••••"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleConnect()}
            disabled={authState === "loading"}
            className="w-full rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-3
                       text-sm text-gray-200 placeholder-gray-600 outline-none
                       focus:border-indigo-500/60 focus:ring-2 focus:ring-indigo-500/20
                       disabled:opacity-50 mb-4 transition"
          />
          <button
            onClick={handleConnect}
            disabled={authState === "loading" || !secret.trim()}
            className="w-full rounded-xl bg-indigo-600 py-3 text-sm font-semibold text-white
                       hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            {authState === "loading" ? "Verifying…" : "Connect"}
          </button>

          {authState === "error" && (
            <p className="mt-4 text-sm text-red-400 flex items-center gap-2">
              <span>⚠</span> {authError}
            </p>
          )}
        </div>
      </div>
    );
  }

  // ── Main app ──────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#0a0b0f] flex items-center justify-center p-4">
      <div className="w-[500px] rounded-2xl border border-white/[0.07] bg-[#13151c] shadow-2xl overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-white/[0.06]">
          <div>
            <h1 className="text-base font-bold text-white tracking-tight">File Streamer</h1>
            <p className="text-[11px] text-emerald-400 mt-0.5 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />
              Connected &amp; encrypted
            </p>
          </div>
          <button onClick={handleDisconnect}
            className="text-xs text-gray-600 hover:text-gray-400 transition">
            Disconnect
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-white/[0.06]">
          {(["upload", "download"] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`flex-1 py-3 text-sm font-medium transition border-b-2 -mb-px
                ${tab === t
                  ? "border-indigo-500 text-indigo-400"
                  : "border-transparent text-gray-600 hover:text-gray-400"}`}>
              {t === "upload" ? "⬆  Upload" : "⬇  Download"}
            </button>
          ))}
        </div>

        <div className="p-6">

          {/* ── Upload Tab ── */}
          {tab === "upload" && (
            <div className="space-y-3">
              <input ref={folderRef} type="file" className="hidden"
                // @ts-ignore
                webkitdirectory="" multiple
                onChange={(e) => handleUpload(e.target.files)} />
              <input ref={fileRef} type="file" className="hidden" multiple
                onChange={(e) => handleUpload(e.target.files)} />

              <button onClick={() => { setUploadDone(false); folderRef.current?.click(); }}
                disabled={uploading}
                className="w-full rounded-xl bg-indigo-600 py-3 text-sm font-semibold text-white
                           hover:bg-indigo-500 disabled:opacity-40 transition">
                📁  Upload Folder
              </button>
              <button onClick={() => { setUploadDone(false); fileRef.current?.click(); }}
                disabled={uploading}
                className="w-full rounded-xl border border-white/[0.08] bg-white/[0.03] py-3
                           text-sm font-semibold text-gray-300 hover:bg-white/[0.06]
                           disabled:opacity-40 transition">
                📄  Upload Files
              </button>

              {uploading && (
                <div className="pt-1">
                  <div className="flex justify-between text-xs text-gray-500 mb-1.5">
                    <span className="truncate max-w-[80%]">{upProg.current}</span>
                    <span>{upPct}%</span>
                  </div>
                  <div className="h-1 rounded-full bg-white/[0.06] overflow-hidden">
                    <div className="h-full bg-indigo-500 transition-all duration-200"
                      style={{ width: `${upPct}%` }} />
                  </div>
                  <p className="mt-1 text-xs text-gray-600">{upProg.done} / {upProg.total} files</p>
                </div>
              )}
              {uploadDone && <p className="text-sm text-emerald-400">✅ {upProg.total} file(s) uploaded</p>}
              {uploadErr  && <p className="text-sm text-red-400">⚠ {uploadErr}</p>}
            </div>
          )}

          {/* ── Download Tab ── */}
          {tab === "download" && (
            <div className="space-y-3">

              {/* Two action buttons */}
              <button onClick={handleDownloadAll} disabled={!!downloading || dlMode === "all"}
                className="w-full rounded-xl bg-indigo-600 py-3 text-sm font-semibold text-white
                           hover:bg-indigo-500 disabled:opacity-40 transition">
                ⬇  Download All Files
              </button>

              <button onClick={handleOpenPicker} disabled={!!downloading}
                className="w-full rounded-xl border border-white/[0.08] bg-white/[0.03] py-3
                           text-sm font-semibold text-gray-300 hover:bg-white/[0.06]
                           disabled:opacity-40 transition">
                🗂  Browse &amp; Download Specific Files
              </button>

              {/* Download-all progress */}
              {dlMode === "all" && !dlDone && (
                <div className="pt-1 space-y-2">
                  <div className="flex justify-between text-xs text-gray-500">
                    <span className="truncate max-w-[75%]">{dlProg.current || "Preparing…"}</span>
                    <span>{dlFPct}%</span>
                  </div>
                  <div className="h-1 rounded-full bg-white/[0.06] overflow-hidden">
                    <div className="h-full bg-indigo-500 transition-all duration-200"
                      style={{ width: `${dlFPct}%` }} />
                  </div>
                  {dlProg.bytesTotal > 0 && (
                    <div className="h-1 rounded-full bg-white/[0.06] overflow-hidden">
                      <div className="h-full bg-teal-500 transition-all duration-200"
                        style={{ width: `${dlBPct}%` }} />
                    </div>
                  )}
                  <p className="text-xs text-gray-600">
                    {dlProg.files} / {dlProg.filesTotal} files
                    {dlProg.bytesTotal > 0 && ` · ${dlBPct}% of current file`}
                  </p>
                </div>
              )}
              {dlMode === "all" && dlDone && (
                <p className="text-sm text-emerald-400">✅ All files downloaded</p>
              )}

              {/* File picker list */}
              {dlMode === "pick" && (
                <div className="pt-1">
                  {loadingList && <p className="text-sm text-gray-500 py-4 text-center">Loading…</p>}
                  {listErr     && <p className="text-sm text-red-400">⚠ {listErr}</p>}

                  {!loadingList && fileList.length === 0 && !listErr && (
                    <p className="text-sm text-gray-600 py-4 text-center">No files on server yet.</p>
                  )}

                  {fileList.length > 0 && (
                    <div className="rounded-xl border border-white/[0.07] overflow-hidden max-h-60 overflow-y-auto">
                      {fileList.map((f) => {
                        const isCurrent = downloading === f;
                        const pct = isCurrent && dlProg.bytesTotal > 0
                          ? Math.round((dlProg.bytes / dlProg.bytesTotal) * 100)
                          : 0;
                        return (
                          <div key={f}
                            className="flex items-center justify-between px-4 py-2.5
                                       border-b border-white/[0.05] last:border-0
                                       hover:bg-white/[0.03] transition">
                            <div className="min-w-0 flex-1 mr-3">
                              <p className="text-xs text-gray-300 truncate" title={f}>
                                {f.includes("/") ? (
                                  <>
                                    <span className="text-gray-600">{f.split("/").slice(0, -1).join("/")}/</span>
                                    {f.split("/").pop()}
                                  </>
                                ) : f}
                              </p>
                              {isCurrent && dlProg.bytesTotal > 0 && (
                                <div className="mt-1.5 h-0.5 rounded-full bg-white/[0.06] overflow-hidden">
                                  <div className="h-full bg-indigo-500 transition-all duration-150"
                                    style={{ width: `${pct}%` }} />
                                </div>
                              )}
                            </div>
                            <button
                              onClick={() => handleDownloadOne(f)}
                              disabled={!!downloading}
                              className="text-xs text-indigo-400 hover:text-indigo-300
                                         disabled:opacity-40 disabled:cursor-not-allowed
                                         shrink-0 transition">
                              {isCurrent ? `${pct}%` : "Download"}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {dlErr && <p className="text-sm text-red-400">⚠ {dlErr}</p>}
            </div>
          )}

        </div>
      </div>
    </div>
  );
}