"use client";

/**
 * How the session ended, from the candidate's point of view.
 *
 * `interrupted` means something went wrong and a recruiter may reissue the
 * link. The other two are ordinary endings and must not be described that way:
 * a candidate who chose to finish was previously told their interview "was
 * interrupted" and that "a recovery attempt may be issued by recruiter", which
 * reads as a fault and invites them to wait for a link that isn't coming.
 */
export type EndedOutcome = "ended_by_candidate" | "ended_tab_switch" | "interrupted";

const CLOSING_COPY: Record<
  EndedOutcome,
  { eyebrow: string; eyebrowClass: string; heading: string; body: string }
> = {
  ended_by_candidate: {
    eyebrow: "Interview ended",
    eyebrowClass: "text-emerald-300/80",
    heading: "You've ended your interview.",
    body: "Everything you answered up to this point has been saved and shared with the recruiter. You can close this window.",
  },
  ended_tab_switch: {
    eyebrow: "Interview ended",
    eyebrowClass: "text-amber-300/80",
    heading: "Your interview was ended automatically.",
    body: "Interviews close after repeated switching away from the interview tab. Your answers up to that point have been saved and shared with the recruiter, along with a note explaining why the session ended.",
  },
  interrupted: {
    eyebrow: "Session interrupted",
    eyebrowClass: "text-cyan-300/70",
    heading: "Your interview was interrupted.",
    body: "This was not something you did. Your answers so far are safe, and the recruiter can send you a link to resume.",
  },
};

export default function SessionClosedScreen({ outcome }: { outcome: EndedOutcome }) {
  const closing = CLOSING_COPY[outcome];

  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center bg-[#0B0F1A] px-6 text-white">
      <div className="max-w-xl text-center">
        <p className={`mb-4 text-xs uppercase tracking-[0.28em] ${closing.eyebrowClass}`}>
          {closing.eyebrow}
        </p>
        <h1 className="mb-4 text-3xl font-medium tracking-[0.04em]">{closing.heading}</h1>
        <p className="text-sm leading-7 text-white/72 md:text-base">{closing.body}</p>
      </div>
    </div>
  );
}
