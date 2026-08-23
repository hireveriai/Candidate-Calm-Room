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
      <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-b from-sky-50 via-white to-cyan-50/70 px-4 py-6 text-slate-900 sm:px-6">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(70rem_35rem_at_50%_-15%,rgba(14,165,233,0.16),transparent_60%),radial-gradient(55rem_30rem_at_100%_110%,rgba(20,184,166,0.14),transparent_65%)]"
        />

        <section className="relative w-full max-w-3xl rounded-[24px] border border-sky-100 bg-white/90 p-6 shadow-[0_24px_60px_-32px_rgba(12,74,110,0.45)] ring-1 ring-white/70 backdrop-blur-sm sm:p-9">
          <div className="flex flex-col items-center text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-500 to-teal-500 text-white shadow-[0_12px_26px_-12px_rgba(14,165,233,0.95)]">
              <ShieldCheck className="h-6 w-6" strokeWidth={1.75} />
            </div>

            <p className="mt-4 text-[10px] font-semibold uppercase tracking-[0.32em] text-sky-700">
              Secure interview access
            </p>

            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900 sm:text-[32px]">
              Ready to start your interview?
            </h1>

            <p className="mt-2 max-w-lg text-sm leading-6 text-slate-500">
              We&rsquo;ll confirm your interview context, then guide you through a
              brief device precheck.
            </p>
          </div>

          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {ASSURANCES.map(({ icon: Icon, title, body }) => (
              <div
                key={title}
                className="flex h-full items-start gap-3 rounded-2xl border border-sky-100 bg-gradient-to-br from-sky-50 to-cyan-50/60 p-4 shadow-[0_10px_24px_-20px_rgba(12,74,110,0.7)] transition hover:border-sky-200 hover:from-sky-100/80 hover:to-cyan-100/60"
              >
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-sky-600 shadow-sm ring-1 ring-sky-100">
                  <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
                </span>
                <div className="text-left">
                  <p className="text-sm font-semibold text-slate-900">{title}</p>
                  <p className="mt-0.5 text-[13px] leading-5 text-slate-500">{body}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-6 flex flex-col items-center">
            <button
              onClick={start}
              disabled={loading || !token}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-sky-600 to-teal-600 px-7 py-3 text-sm font-semibold text-white shadow-[0_16px_34px_-18px_rgba(2,132,199,0.95)] transition hover:from-sky-700 hover:to-teal-700 disabled:cursor-not-allowed disabled:opacity-45 sm:w-auto sm:text-base"
            >
              {loading ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowRight className="h-4 w-4" />
              )}
              Start Interview
            </button>

            {error && (
              <p className="mt-4 w-full rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-center text-sm leading-6 text-rose-700">
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
