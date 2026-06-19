"use client";

import { useState } from "react";
import { ArrowRight, LoaderCircle, ShieldCheck } from "lucide-react";
import IdentityVerificationModal from "./IdentityVerificationModal";
import type { IdentityVerificationSummary } from "@/app/lib/identity-verification/types";

type Props = {
  token: string;
  onReadyForPrecheck: () => void;
};

type ContextPayload = {
  candidateCountry: string | null;
  jobCountry: string | null;
  verification: IdentityVerificationSummary | null;
};

function browserCountry() {
  const locale = navigator.languages?.[0] || navigator.language || "";
  const region = locale.split("-")[1]?.toUpperCase();
  return region === "IN" ? "India" : region || null;
}

export default function InterviewEntryGate({ token, onReadyForPrecheck }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [country, setCountry] = useState("");
  const [verification, setVerification] =
    useState<IdentityVerificationSummary | null>(null);

  async function start() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(
        `/api/identity-verification/context?token=${encodeURIComponent(token)}`,
        { cache: "no-store" }
      );
      const payload = (await response.json()) as ContextPayload & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Unable to load interview");

      const detectedCountry =
        payload.candidateCountry || payload.jobCountry || browserCountry();
      setCountry(detectedCountry || "");
      setVerification(payload.verification);

      if (detectedCountry?.toLowerCase() !== "india") {
        onReadyForPrecheck();
        return;
      }

      if (
        payload.verification &&
        ["verified", "partial", "skipped"].includes(payload.verification.status)
      ) {
        onReadyForPrecheck();
        return;
      }

      setModalOpen(true);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "Unable to start");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <main className="flex min-h-screen items-center justify-center bg-[#070b14] px-6 text-white">
        <section className="w-full max-w-2xl rounded-[30px] border border-white/10 bg-[radial-gradient(circle_at_top,rgba(34,211,238,.12),transparent_45%),#0b1120] p-8 text-center shadow-2xl md:p-12">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-cyan-300/20 bg-cyan-300/10 text-cyan-200">
            <ShieldCheck className="h-7 w-7" />
          </div>
          <p className="mt-7 text-xs uppercase tracking-[0.3em] text-cyan-300/65">
            Secure interview access
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
            Ready to start your interview?
          </h1>
          <p className="mx-auto mt-4 max-w-lg text-sm leading-7 text-slate-400 md:text-base">
            We’ll confirm your interview context, then guide you through a brief device precheck.
          </p>
          <button
            onClick={start}
            disabled={loading || !token}
            className="mx-auto mt-8 inline-flex items-center gap-2 rounded-xl bg-cyan-400 px-6 py-3 font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
            Start Interview
          </button>
          {error && <p className="mt-4 text-sm text-rose-300">{error}</p>}
        </section>
      </main>

      <IdentityVerificationModal
        open={modalOpen}
        token={token}
        country={country || "India"}
        initialVerification={verification}
        onContinue={() => {
          setModalOpen(false);
          onReadyForPrecheck();
        }}
      />
    </>
  );
}

