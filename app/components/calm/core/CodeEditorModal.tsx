"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

const MonacoEditor = dynamic(
  () => import("@monaco-editor/react").then((mod) => mod.default),
  {
    ssr: false,
  }
);

const LANGUAGES = [
  { label: "JavaScript", value: "javascript" },
  { label: "TypeScript", value: "typescript" },
  { label: "SQL", value: "sql" },
  { label: "Python", value: "python" },
  { label: "Java", value: "java" },
  { label: "C++", value: "cpp" },
  { label: "C", value: "c" },
  { label: "C#", value: "csharp" },
  { label: "Go", value: "go" },
  { label: "Rust", value: "rust" },
  { label: "Kotlin", value: "kotlin" },
  { label: "Swift", value: "swift" },
  { label: "PHP", value: "php" },
];

type Props = {
  open: boolean;
  question: string;
  onClose: () => void;
};

export default function CodeEditorModal({ open, question, onClose }: Props) {
  const [code, setCode] = useState("");
  const [language, setLanguage] = useState("javascript");
  const [editorReady, setEditorReady] = useState(false);

  const prevLength = useRef(0);
  const lastTypeTime = useRef(Date.now());

  useEffect(() => {
    let mounted = true;

    const configureMonaco = async () => {
      const [{ loader }, monaco] = await Promise.all([
        import("@monaco-editor/react"),
        import("monaco-editor"),
      ]);

      loader.config({ monaco });

      if (mounted) {
        setEditorReady(true);
      }
    };

    configureMonaco().catch((error) => {
      console.error("Monaco setup failed:", error);
    });

    return () => {
      mounted = false;
    };
  }, []);

  // 📋 DIRECT PASTE DETECTION
  useEffect(() => {
    const handlePaste = () => {
      window.dispatchEvent(
        new CustomEvent("hireveri-event", {
          detail: { type: "DIRECT_PASTE" },
        })
      );
    };

    document.addEventListener("paste", handlePaste);

    return () => document.removeEventListener("paste", handlePaste);
  }, []);

  // 🔥 CHANGE HANDLER
  const handleChange = (val: string | undefined) => {
    const newCode = val || "";
    const newLength = newCode.length;
    const oldLength = prevLength.current;

    const diff = newLength - oldLength;
    const now = Date.now();

    // 🚨 LARGE INSERT (PASTE)
    if (diff > 20) {
      window.dispatchEvent(
        new CustomEvent("hireveri-event", {
          detail: { type: "CODE_PASTE" },
        })
      );
    }

    // 🚨 FAST INPUT
    if (diff > 10 && now - lastTypeTime.current < 100) {
      window.dispatchEvent(
        new CustomEvent("hireveri-event", {
          detail: { type: "FAST_TYPING" },
        })
      );
    }

    prevLength.current = newLength;
    lastTypeTime.current = now;

    setCode(newCode);
  };

  // ✅ SAFE TO RETURN AFTER HOOKS
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">

      {/* BACKDROP */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

      {/* MODAL */}
      <div className="relative w-[85%] max-w-6xl bg-[#020617] border border-white/10 rounded-2xl p-4">

        {/* HEADER */}
        <div className="flex justify-between items-center mb-3">
          <div className="text-white/80 text-sm">
            💻 {question}
          </div>

          <button
            onClick={onClose}
            className="text-red-400 text-sm border border-red-400/30 px-3 py-1 rounded-full"
          >
            Close
          </button>
        </div>

        {/* LANGUAGE */}
        <div className="flex justify-end mb-2">
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            className="bg-black/40 border border-white/10 text-white text-xs px-2 py-1 rounded-md"
          >
            {LANGUAGES.map((lang) => (
              <option key={lang.value} value={lang.value}>
                {lang.label}
              </option>
            ))}
          </select>
        </div>

        {/* EDITOR */}
        <div className="rounded-xl overflow-hidden border border-white/10">
          {editorReady ? (
            <MonacoEditor
              height="400px"
              language={language}
              value={code}
              onChange={handleChange}
              theme="vs-dark"
              loading="Preparing editor..."
              options={{
                minimap: { enabled: false },
                fontSize: 14,
                automaticLayout: true,
                wordWrap: "on",
              }}
            />
          ) : (
            <div className="flex h-[400px] items-center justify-center bg-black/30 text-sm text-white/60">
              Preparing editor...
            </div>
          )}
        </div>

        {/* FOOTER */}
        <div className="flex justify-between items-center mt-3">
          <div className="text-white/40 text-xs">
            ⚡ Behavioral monitoring active
          </div>

          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="text-white/60 text-sm px-3 py-1"
            >
              Cancel
            </button>

            <button
              onClick={onClose}
              className="bg-blue-500/20 border border-blue-400/40 text-blue-300 px-4 py-1 rounded-md text-sm"
            >
              Submit
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
