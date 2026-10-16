import assert from "node:assert/strict";
import test from "node:test";

import { RECONNECT_BACKOFF_MS } from "./interviewSessionReliability";
import {
  INITIAL_RECONNECT_FLAP_STATE,
  MAX_RECONNECT_FLAP_EPISODES,
  RECONNECT_FLAP_WINDOW_MS,
  markReconnectRecovered,
  planReconnectEpisode,
  type ReconnectFlapState,
} from "./reconnectFlapPolicy";

test("a first disconnect reconnects immediately", () => {
  const plan = planReconnectEpisode(INITIAL_RECONNECT_FLAP_STATE, 1_000);

  assert.equal(plan.episode, 1);
  assert.equal(plan.delayMs, 0);
  assert.equal(plan.giveUp, false);
});

test("a disconnect long after the last recovery is a fresh outage", () => {
  const recovered = markReconnectRecovered({ lastRecoveredAt: null, consecutiveEpisodes: 4 }, 0);
  const plan = planReconnectEpisode(recovered, RECONNECT_FLAP_WINDOW_MS + 1);

  assert.equal(plan.episode, 1);
  assert.equal(plan.delayMs, 0);
});

test("a connection that keeps dropping backs off along the reconnect ladder, then gives up", () => {
  // Reproduces the 2026-10-15 storm: heartbeat recovers in ~1s, media drops
  // again at once. Previously every one of these restarted at attempt 1.
  let state: ReconnectFlapState = INITIAL_RECONNECT_FLAP_STATE;
  let now = 0;
  const delays: number[] = [];
  let gaveUpAtEpisode: number | null = null;

  for (let i = 0; i < 20 && gaveUpAtEpisode === null; i += 1) {
    const plan = planReconnectEpisode(state, now);
    state = plan.state;

    if (plan.giveUp) {
      gaveUpAtEpisode = plan.episode;
      break;
    }

    delays.push(plan.delayMs);
    now += plan.delayMs + 1_000; // wait, then "recover" via heartbeat
    state = markReconnectRecovered(state, now);
    now += 100; // media fails again almost immediately
  }

  assert.deepEqual(delays, [0, ...RECONNECT_BACKOFF_MS]);
  assert.equal(gaveUpAtEpisode, MAX_RECONNECT_FLAP_EPISODES + 1);
  // Total time spent retrying stays bounded (~36s here) instead of looping.
  assert.ok(now < 60_000, `retried for ${now}ms`);
});

test("one stable minute resets the backoff", () => {
  let state = planReconnectEpisode(INITIAL_RECONNECT_FLAP_STATE, 0).state;
  state = markReconnectRecovered(state, 1_000);
  state = planReconnectEpisode(state, 2_000).state; // flap: episode 2
  state = markReconnectRecovered(state, 3_000);

  const later = planReconnectEpisode(state, 3_000 + RECONNECT_FLAP_WINDOW_MS + 1);
  assert.equal(later.episode, 1);
  assert.equal(later.delayMs, 0);
});
