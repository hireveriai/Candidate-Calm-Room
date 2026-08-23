"use client";

import { useState } from "react";
import {
  ArrowRight,
  Clock,
  LoaderCircle,
  Lock,
  ShieldCheck,
  Video,
} from "lucide-react";
import IdentityVerificationModal from "./IdentityVerificationModal";
import type { IdentityVerificationSummary } from "@/app/lib/identity-verification/types";

type Props = {
  token: string;
  onReadyForPrecheck: () => void;
};

type ContextPayload = {
  candidateCountry: string | null;
  jobCountry: string | null;
  deviceRequirement: "DESKTOP_ONLY" | "MOBILE_ONLY" | "ANY_DEVICE";
  verification: IdentityVerificationSummary | null;
};

function browserCountry() {
  const locale = navigator.languages?.[0] || navigator.language || "";
  const region = locale.split("-")[1]?.toUpperCase();
  return region === "IN" ? "India" : region || null;
}

function isMobileDevice() {
  return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);
}

const ASSURANCES = [
  {
    icon: ShieldCheck,
    title: "Identity confirmed",
    body: "We verify your interview context before anything begins.",
  },
  {
    icon: Video,
    title: "Device precheck",
    body: "A quick camera and microphone test — no attempt is used.",
  },
  {
    icon: Clock,
    title: "Under a minute",
    body: "Setup is short so you can settle in before question one.",
  },
  {
    icon: Lock,
    title: "Private by default",
    body: "Your session is encrypted and shared only with the recruiter.",
  },
];

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

      const mobile = isMobileDevice();
      if (payload.deviceRequirement === "DESKTOP_ONLY" && mobile) {
        throw new Error("This interview must be completed on a laptop or desktop. Please open this link on a computer to continue.");
      }
      if (payload.deviceRequirement === "MOBILE_ONLY" && !mobile) {
        throw new Error("This interview must be completed on a mobile device. Please open this link on your phone to continue.");
      }

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
      <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-white px-5 py-12 text-slate-900 sm:px-6">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(90rem_45rem_at_50%_-20%,rgba(6,182,212,0.10),transparent_60%),radial-gradient(60rem_35rem_at_100%_110%,rgba(15,23,42,0.06),transparent_65%)]"
        />

        <section className="relative w-full max-w-3xl rounded-[28px] border border-slate-200/80 bg-white/95 p-8 shadow-[0_30px_80px_-40px_rgba(15,23,42,0.45)] backdrop-blur-sm sm:p-12">
          <div className="flex flex-col items-center text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-500 to-teal-500 text-white shadow-[0_12px_30px_-12px_rgba(8,145,178,0.85)]">
              <ShieldCheck className="h-7 w-7" strokeWidth={1.75} />
            </div>

            <p className="mt-7 text-[11px] font-semibold uppercase tracking-[0.32em] text-cyan-700">
              Secure interview access
            </p>

            <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
              Ready to start your interview?
            </h1>

            <p className="mt-4 max-w-lg text-sm leading-7 text-slate-500 sm:text-base">
              We&rsquo;ll confirm your interview context, then guide you through a
              brief device precheck.
            </p>
          </div>

          <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {ASSURANCES.map(({ icon: Icon, title, body }) => (
              <div
                key={title}
                className="flex h-full items-start gap-4 rounded-2xl border border-slate-200 bg-slate-50/70 p-5 transition-colors hover:border-cyan-200 hover:bg-cyan-50/50"
              >
                <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cyan-100 bg-white text-cyan-600 shadow-sm">
                  <Icon className="h-5 w-5" strokeWidth={1.75} />
                </span>
                <div className="text-left">
                  <p className="text-sm font-semibold text-slate-900">{title}</p>
                  <p className="mt-1 text-[13px] leading-6 text-slate-500">{body}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-10 flex flex-col items-center">
            <button
              onClick={start}
              disabled={loading || !token}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-7 py-3.5 text-sm font-semibold text-white shadow-[0_18px_40px_-20px_rgba(15,23,42,0.9)] transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-45 sm:w-auto sm:text-base"
            >
              {loading ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowRight className="h-4 w-4" />
              )}
              Start Interview
            </button>

            {error && (
              <p className="mt-5 w-full rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-center text-sm leading-6 text-rose-700">
                {error}
              </p>
            )}
          </div>
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
