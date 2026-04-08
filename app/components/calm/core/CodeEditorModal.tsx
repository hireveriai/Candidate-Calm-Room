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
  onSubmit: (payload: { code: string; language: string }) => void | Promise<void>;
};

export default function CodeEditorModal({
  open,
  question,
  onClose,
  onSubmit,
}: Props) {
  const [code, setCode] = useState("");
  const [language, setLanguage] = useState("javascript");
  const [editorReady, setEditorReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const prevLength = useRef(0);

  useEffect(() => {
    if (!open || editorReady) {
      return;
    }

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
  }, [editorReady, open]);

  useEffect(() => {
    if (!open) return;

    setCode("");
    setLanguage("javascript");
    setSubmitting(false);
    prevLength.current = 0;
  }, [open, question]);

  useEffect(() => {
    if (!open) return;

    const handleCopy = () => {
      window.dispatchEvent(
        new CustomEvent("hireveri-event", {
          detail: { type: "coding_copy" },
        })
      );
    };

    const handlePaste = () => {
      window.dispatchEvent(
        new CustomEvent("hireveri-event", {
          detail: { type: "coding_paste" },
        })
      );
    };

    document.addEventListener("copy", handleCopy);
    document.addEventListener("paste", handlePaste);

    return () => {
      document.removeEventListener("copy", handleCopy);
      document.removeEventListener("paste", handlePaste);
    };
  }, [open]);

  const handleChange = (value: string | undefined) => {
    const nextCode = value || "";
    const diff = nextCode.length - prevLength.current;

    if (diff > 20) {
      window.dispatchEvent(
        new CustomEvent("hireveri-event", {
          detail: { type: "coding_paste" },
        })
      );
    }

    prevLength.current = nextCode.length;
    setCode(nextCode);
  };

  const handleSubmit = async () => {
    if (!code.trim() || submitting) return;

    setSubmitting(true);

    try {
      await onSubmit({
        code: code.trim(),
        language,
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

      <div className="relative w-[85%] max-w-6xl rounded-2xl border border-white/10 bg-[#020617] p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm text-white/80">{question}</div>

          <button
            onClick={onClose}
            disabled={submitting}
            className="rounded-full border border-red-400/30 px-3 py-1 text-sm text-red-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Close
          </button>
        </div>

        <div className="mb-2 flex justify-end">
          <select
            value={language}
            onChange={(event) => setLanguage(event.target.value)}
            className="rounded-md border border-white/10 bg-black/40 px-2 py-1 text-xs text-white"
          >
            {LANGUAGES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </div>

        <div className="overflow-hidden rounded-xl border border-white/10">
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

        <div className="mt-3 flex items-center justify-between">
          <div className="text-xs text-white/40">Behavioral monitoring active</div>

          <div className="flex gap-2">
            <button
              onClick={onClose}
              disabled={submitting}
              className="px-3 py-1 text-sm text-white/60 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Cancel
            </button>

            <button
              onClick={() => void handleSubmit()}
              disabled={submitting || !code.trim()}
              className="rounded-md border border-blue-400/40 bg-blue-500/20 px-4 py-1 text-sm text-blue-300 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting ? "Submitting..." : "Submit"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
