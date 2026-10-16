import { RECONNECT_BACKOFF_MS } from "./interviewSessionReliability";

/**
 * A "recovery" only proves the API answered a heartbeat. When the realtime
 * media connection itself cannot be restored (LiveKit down, token/config
 * failing, a candidate's network flapping), the video panel remounts, fails
 * immediately and reports another disconnect. Each of those used to start a
 * fresh episode at attempt 1 with no delay, so the page looped about once a
 * second and every loop uploaded a new recording segment.
 *
 * A disconnect within this window of the last recovery is treated as the same
 * outage: it backs off along the existing reconnect ladder and the interview is
 * closed safely once the ladder is exhausted.
 */
export const RECONNECT_FLAP_WINDOW_MS = 60_000;

/** First episode plus one per backoff step (1s, 2s, 4s, 8s, 15s). */
export const MAX_RECONNECT_FLAP_EPISODES = RECONNECT_BACKOFF_MS.length + 1;

export type ReconnectFlapState = {
  lastRecoveredAt: number | null;
  consecutiveEpisodes: number;
};

export const INITIAL_RECONNECT_FLAP_STATE: ReconnectFlapState = {
  lastRecoveredAt: null,
  consecutiveEpisodes: 0,
};

export type ReconnectEpisodePlan = {
  state: ReconnectFlapState;
  /** 1 for a fresh outage, higher while the connection keeps dropping. */
  episode: number;
  /** Wait before the first reconnect attempt of this episode. */
  delayMs: number;
  /** The connection keeps failing; close the interview instead of retrying. */
  giveUp: boolean;
};

export function planReconnectEpisode(
  state: ReconnectFlapState,
  nowMs: number
): ReconnectEpisodePlan {
  const flapping =
    state.lastRecoveredAt !== null &&
    nowMs - state.lastRecoveredAt <= RECONNECT_FLAP_WINDOW_MS;
  const episode = flapping ? state.consecutiveEpisodes + 1 : 1;
  const giveUp = episode > MAX_RECONNECT_FLAP_EPISODES;
  const delayMs =
    episode <= 1 || giveUp
      ? 0
      : RECONNECT_BACKOFF_MS[Math.min(episode - 2, RECONNECT_BACKOFF_MS.length - 1)];

  return {
    state: { lastRecoveredAt: state.lastRecoveredAt, consecutiveEpisodes: episode },
    episode,
    delayMs,
    giveUp,
  };
}

export function markReconnectRecovered(
  state: ReconnectFlapState,
  nowMs: number
): ReconnectFlapState {
  return { ...state, lastRecoveredAt: nowMs };
}
