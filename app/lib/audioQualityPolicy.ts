export type AudioQualityWindow = {
  averageRms: number;
  variability: number;
  activeRatio: number;
  activeSampleCount: number;
};

export type AudioQualityClassification = {
  lowMicrophoneVolume: boolean;
  backgroundNoiseDetected: boolean;
};

/**
 * Conservative recording-quality checks. These are factual capture signals,
 * not candidate-performance signals, and require sustained confirmation in
 * AmbientMic before they are persisted.
 */
export function classifyAudioQualityWindow(
  window: AudioQualityWindow,
): AudioQualityClassification {
  const lowMicrophoneVolume =
    window.activeSampleCount >= 8 &&
    window.averageRms >= 0.01 &&
    window.averageRms < 0.025;

  const backgroundNoiseDetected =
    window.activeSampleCount >= 24 &&
    window.activeRatio >= 0.85 &&
    window.averageRms >= 0.035 &&
    window.variability <= 0.012;

  return {
    lowMicrophoneVolume,
    backgroundNoiseDetected,
  };
}
