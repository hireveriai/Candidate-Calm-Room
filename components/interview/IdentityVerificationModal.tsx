"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  BadgeCheck,
  Camera,
  CheckCircle2,
  FileStack,
  Landmark,
  LoaderCircle,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import type {
  IdentityVerificationSummary,
  VerificationDocumentType,
} from "@/app/lib/identity-verification/types";

type Props = {
  open: boolean;
  token: string;
  country: string;
  initialVerification: IdentityVerificationSummary | null;
  onContinue: (verification: IdentityVerificationSummary | null) => void;
};

type RequestState = "idle" | "pending" | "connected" | "failed";

const uploadTypes: Array<{ value: VerificationDocumentType; label: string }> = [
  { value: "aadhaar", label: "Aadhaar" },
  { value: "pan", label: "PAN" },
  { value: "passport", label: "Passport" },
  { value: "degree", label: "Degree" },
  { value: "experience", label: "Experience Letter" },
];

export default function IdentityVerificationModal({
  open,
  token,
  country,
  initialVerification,
  onContinue,
}: Props) {
  const cameraInput = useRef<HTMLInputElement>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const [verification, setVerification] = useState(initialVerification);
  const [digilockerState, setDigilockerState] = useState<RequestState>("idle");
  const [scanState, setScanState] = useState<RequestState>("idle");
  const [uploadState, setUploadState] = useState<RequestState>("idle");
  const [documentType, setDocumentType] =
    useState<VerificationDocumentType>("aadhaar");
  const [message, setMessage] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);

  if (!open) return null;

  async function decide(action: "skip" | "connect_digilocker" | "continue_after_failure") {
    const response = await fetch("/api/identity-verification/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, action, country }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Verification request failed");
    setVerification(payload.verification);
    setMessage(payload.message || "");
    return payload as {
      verification: IdentityVerificationSummary;
      allowContinue?: boolean;
    };
  }

  async function connectDigiLocker() {
    setDigilockerState("pending");
    setMessage("");
    try {
      const payload = await decide("connect_digilocker");
      setDigilockerState(
        payload.verification.digilockerConnected ? "connected" : "failed"
      );
      if (payload.verification.digilockerConnected) onContinue(payload.verification);
    } catch (error) {
      setDigilockerState("failed");
      setMessage(error instanceof Error ? error.message : "DigiLocker connection failed");
    }
  }

  async function uploadFiles(files: File[], type: VerificationDocumentType) {
    if (!files.length) return;
    const isScan = type === "aadhaar" && files.length === 1;
    if (isScan) {
      setScanState("pending");
    } else {
      setUploadState("pending");
    }
    setMessage("");

    const form = new FormData();
    form.set("token", token);
    form.set("country", country);
    form.set("documentType", type);
    files.forEach((file) => form.append("files", file));

    try {
      const response = await fetch("/api/identity-verification/upload", {
        method: "POST",
        body: form,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Upload failed");
      setVerification(payload.verification);
      if (isScan) {
        setScanState("connected");
      } else {
        setUploadState("connected");
      }
      setMessage(
        payload.ocrProcessed
          ? "Aadhaar uploaded and processed. Only the last four digits are retained."
          : "Document uploaded securely."
      );
    } catch (error) {
      if (isScan) {
        setScanState("failed");
      } else {
        setUploadState("failed");
      }
      setMessage(error instanceof Error ? error.message : "Upload failed");
    }
  }

  async function skip() {
    try {
      const payload = await decide("skip");
      onContinue(payload.verification);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to continue");
    }
  }

  const canContinue = Boolean(
    verification &&
      ["verified", "partial", "failed"].includes(verification.status)
  );

  return (
    <div
      className="fixed inset-0 z-[100] overflow-y-auto bg-[#030712]/90 px-4 py-6 backdrop-blur-xl"
      role="dialog"
      aria-modal="true"
      aria-labelledby="identity-verification-title"
    >
      <div className="mx-auto max-w-5xl overflow-hidden rounded-[28px] border border-white/10 bg-[#0a1020] shadow-[0_30px_100px_rgba(0,0,0,.65)]">
        <div className="border-b border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,.14),transparent_42%)] px-6 py-7 md:px-9">
          <div className="flex items-start gap-4">
            <div className="rounded-2xl border border-cyan-300/20 bg-cyan-300/10 p-3 text-cyan-200">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.28em] text-cyan-300/70">
                Optional identity verification
              </p>
              <h1
                id="identity-verification-title"
                className="mt-2 text-2xl font-semibold tracking-tight text-white md:text-3xl"
              >
                Strengthen Your Candidate Trust Profile
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">
                Verify your identity before interview to increase recruiter confidence.
              </p>
            </div>
          </div>
        </div>

        <div className="grid gap-4 p-5 md:grid-cols-2 md:p-8">
          <OptionCard
            icon={<Landmark className="h-5 w-5" />}
            title="DigiLocker"
            badge="Recommended"
            description="Securely fetch Aadhaar, PAN, Degree or Experience documents."
            state={digilockerState}
          >
            <button className="primary-button" onClick={connectDigiLocker}>
              {digilockerState === "pending" && <LoaderCircle className="h-4 w-4 animate-spin" />}
              Connect DigiLocker
            </button>
          </OptionCard>

          <OptionCard
            icon={<Camera className="h-5 w-5" />}
            title="Scan Aadhaar"
            description="Use this camera or your mobile device to capture the front side."
            state={scanState}
          >
            <input
              ref={cameraInput}
              className="hidden"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              capture="environment"
              onChange={(event) =>
                void uploadFiles(Array.from(event.target.files ?? []), "aadhaar")
              }
            />
            <button className="secondary-button" onClick={() => setCameraOpen(true)}>
              <Camera className="h-4 w-4" />
              Scan with Camera
            </button>
            <button
              className="text-left text-xs text-slate-500 hover:text-slate-300"
              onClick={() => cameraInput.current?.click()}
            >
              Use mobile camera / choose an image instead
            </button>
          </OptionCard>

          <OptionCard
            icon={<FileStack className="h-5 w-5" />}
            title="Upload Documents"
            description="Upload one or more private verification documents."
            state={uploadState}
          >
            <div className="flex flex-wrap gap-2">
              {uploadTypes.map((type) => (
                <button
                  key={type.value}
                  onClick={() => setDocumentType(type.value)}
                  className={`rounded-full border px-3 py-1.5 text-xs transition ${
                    documentType === type.value
                      ? "border-cyan-300/40 bg-cyan-300/10 text-cyan-100"
                      : "border-white/10 text-slate-400 hover:border-white/20"
                  }`}
                >
                  {type.label}
                </button>
              ))}
            </div>
            <input
              ref={uploadInput}
              className="hidden"
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp,application/pdf"
              onChange={(event) =>
                void uploadFiles(Array.from(event.target.files ?? []), documentType)
              }
            />
            <button className="secondary-button" onClick={() => uploadInput.current?.click()}>
              Upload {uploadTypes.find((type) => type.value === documentType)?.label}
            </button>
          </OptionCard>

          <div className="flex flex-col justify-between rounded-2xl border border-white/10 bg-white/[0.025] p-5">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold text-white">
                <BadgeCheck className="h-5 w-5 text-slate-400" />
                Continue without verification
              </div>
              <p className="mt-3 text-sm leading-6 text-slate-400">
                Verification is optional and never prevents you from entering the interview.
              </p>
            </div>
            <button className="mt-6 rounded-xl px-4 py-2.5 text-sm text-slate-300 transition hover:bg-white/5 hover:text-white" onClick={skip}>
              Continue Unverified
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t border-white/10 bg-black/15 px-6 py-5 md:flex-row md:items-center md:justify-between md:px-8">
          <div className="min-h-5 text-sm text-slate-400">
            {message || "Your documents remain private and are shared only for this interview."}
          </div>
          {canContinue && (
            <button className="primary-button shrink-0" onClick={() => onContinue(verification)}>
              Continue to Precheck
            </button>
          )}
        </div>
      </div>
      {cameraOpen && (
        <AadhaarCameraCapture
          onClose={() => setCameraOpen(false)}
          onCapture={(file) => {
            setCameraOpen(false);
            void uploadFiles([file], "aadhaar");
          }}
        />
      )}
      <style jsx>{`
        .primary-button,
        .secondary-button {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 0.5rem;
          border-radius: 0.75rem;
          padding: 0.625rem 1rem;
          font-size: 0.875rem;
          font-weight: 600;
          transition: 160ms ease;
        }
        .primary-button {
          background: #22d3ee;
          color: #071018;
        }
        .primary-button:hover {
          background: #67e8f9;
        }
        .secondary-button {
          border: 1px solid rgba(255, 255, 255, 0.12);
          background: rgba(255, 255, 255, 0.04);
          color: white;
        }
        .secondary-button:hover {
          border-color: rgba(103, 232, 249, 0.35);
          background: rgba(34, 211, 238, 0.08);
        }
      `}</style>
    </div>
  );
}

function AadhaarCameraCapture({
  onClose,
  onCapture,
}: {
  onClose: () => void;
  onCapture: (file: File) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void navigator.mediaDevices
      .getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      })
      .catch(() => setError("Camera access was unavailable. Use the mobile/image option instead."));

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  function capture() {
    const video = videoRef.current;
    if (!video?.videoWidth || !video.videoHeight) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (blob) {
          onCapture(new File([blob], "aadhaar-front.jpg", { type: "image/jpeg" }));
        }
      },
      "image/jpeg",
      0.92
    );
  }

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/90 p-4">
      <div className="w-full max-w-2xl rounded-3xl border border-white/10 bg-[#0a1020] p-5 shadow-2xl">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-white">Capture Aadhaar front</h2>
            <p className="mt-1 text-sm text-slate-400">Align the card inside the frame and avoid glare.</p>
          </div>
          <button onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-white/5">
            Close
          </button>
        </div>
        <div className="relative mt-5 aspect-[16/10] overflow-hidden rounded-2xl bg-black">
          <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-cover" />
          <div className="pointer-events-none absolute inset-[12%] rounded-xl border-2 border-cyan-300/70 shadow-[0_0_0_999px_rgba(0,0,0,.28)]" />
        </div>
        {error && <p className="mt-3 text-sm text-amber-200">{error}</p>}
        <button
          onClick={capture}
          disabled={Boolean(error)}
          className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-cyan-400 px-5 py-3 font-semibold text-slate-950 hover:bg-cyan-300 disabled:opacity-40"
        >
          <Camera className="h-4 w-4" />
          Capture front side
        </button>
      </div>
    </div>
  );
}

function OptionCard({
  icon,
  title,
  badge,
  description,
  state,
  children,
}: {
  icon: ReactNode;
  title: string;
  badge?: string;
  description: string;
  state: RequestState;
  children: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-white">
          <span className="text-cyan-200">{icon}</span>
          {title}
          {badge && (
            <span className="rounded-full border border-emerald-300/20 bg-emerald-300/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-emerald-200">
              {badge}
            </span>
          )}
        </div>
        <Status state={state} />
      </div>
      <p className="mt-3 min-h-12 text-sm leading-6 text-slate-400">{description}</p>
      <div className="mt-5 flex flex-col gap-3">{children}</div>
    </div>
  );
}

function Status({ state }: { state: RequestState }) {
  if (state === "pending") {
    return <span className="text-xs text-amber-200">Pending</span>;
  }
  if (state === "connected") {
    return (
      <span className="flex items-center gap-1 text-xs text-emerald-200">
        <CheckCircle2 className="h-3.5 w-3.5" /> Connected
      </span>
    );
  }
  if (state === "failed") {
    return (
      <span className="flex items-center gap-1 text-xs text-rose-200">
        <XCircle className="h-3.5 w-3.5" /> Failed
      </span>
    );
  }
  return <span className="text-xs text-slate-500">Pending</span>;
}
