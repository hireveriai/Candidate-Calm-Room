function normalizeTranscript(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function comparableWord(value: string) {
  return value.toLowerCase().replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, "");
}

function wordsMatch(left: string, right: string) {
  return comparableWord(left) === comparableWord(right);
}

/**
 * SpeechRecognition periodically ends and has to be recreated. A recreated
 * recognizer only knows about its new session, so its first result must be
 * merged with the answer already captured by the previous instance.
 *
 * The returned transcript is monotonic: a shorter or overlapping update can
 * never erase words that were already captured.
 */
export function mergeMonotonicTranscript(
  existingValue: unknown,
  incomingValue: unknown
) {
  const existing = normalizeTranscript(existingValue);
  const incoming = normalizeTranscript(incomingValue);

  if (!existing) return incoming;
  if (!incoming) return existing;
  if (existing === incoming) return existing;
  if (incoming.startsWith(existing)) return incoming;
  if (existing.startsWith(incoming)) return existing;

  const existingWords = existing.split(" ");
  const incomingWords = incoming.split(" ");
  const maxOverlap = Math.min(existingWords.length, incomingWords.length);

  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    const existingStart = existingWords.length - overlap;
    let matches = true;

    for (let index = 0; index < overlap; index += 1) {
      if (!wordsMatch(existingWords[existingStart + index], incomingWords[index])) {
        matches = false;
        break;
      }
    }

    if (matches) {
      return [...existingWords, ...incomingWords.slice(overlap)].join(" ").trim();
    }
  }

  return `${existing} ${incoming}`.trim();
}

