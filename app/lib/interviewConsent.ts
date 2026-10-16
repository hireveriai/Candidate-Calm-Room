/**
 * What a candidate agrees to before an AI interview can start. The version is
 * stored with each consent (public.interview_consents); change it whenever the
 * wording or the retention periods below change, so older consents stay
 * attributable to the text the candidate actually saw.
 */
export const INTERVIEW_CONSENT_VERSION = "2026-10-ai-interview-v1";

/** Recordings and identity documents are deleted this long after the interview. */
export const MEDIA_RETENTION_DAYS = 30;

/** Default for organizations that have not chosen a candidate-data retention period. */
export const DEFAULT_CANDIDATE_DATA_RETENTION_DAYS = 365;

export const INTERVIEW_CONSENT_POINTS = [
  "Your camera, microphone and answers are recorded for this interview.",
  "Your answers are transcribed and evaluated with AI, and the hiring team reviews the results.",
  "Integrity signals are monitored during the interview: face presence, looking away, tab switching and copy/paste.",
  `Recordings and identity documents are deleted ${MEDIA_RETENTION_DAYS} days after the interview. Your answers, transcript and scores are kept for the employer's chosen period (up to ${DEFAULT_CANDIDATE_DATA_RETENTION_DAYS} days by default) and then deleted.`,
] as const;

export function isCurrentConsentVersion(value: unknown) {
  return value === INTERVIEW_CONSENT_VERSION;
}
