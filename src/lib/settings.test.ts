import { beforeEach, describe, expect, it } from "vitest";
import {
  buildAudioConstraints,
  DEFAULT_APP_SETTINGS,
  loadAppSettings,
  normalizeAppSettings,
  resetAppSettings,
  saveAppSettings,
} from "./settings";

describe("settings helpers", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("normalizes invalid settings back to safe defaults", () => {
    expect(normalizeAppSettings(null)).toEqual(DEFAULT_APP_SETTINGS);
    expect(
      normalizeAppSettings({
        applauseDurationSec: 99,
        echoCancellation: "yes",
        micDeviceId: 123,
      }),
    ).toEqual(DEFAULT_APP_SETTINGS);
  });

  it("persists, patches, and resets settings in localStorage", () => {
    const saved = saveAppSettings({
      micDeviceId: "usb-mic-1",
      applauseDurationSec: 15,
      autoGainControl: true,
      reducedEffects: true,
    });
    expect(saved.micDeviceId).toBe("usb-mic-1");
    expect(saved.applauseDurationSec).toBe(15);
    expect(loadAppSettings().reducedEffects).toBe(true);

    const reset = resetAppSettings();
    expect(reset).toEqual(DEFAULT_APP_SETTINGS);
    expect(loadAppSettings()).toEqual(DEFAULT_APP_SETTINGS);
  });

  it("builds MediaTrackConstraints honoring selected device and processing toggles", () => {
    expect(buildAudioConstraints(DEFAULT_APP_SETTINGS)).toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
    });

    expect(
      buildAudioConstraints({
        micDeviceId: "dev-42",
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true,
      }),
    ).toEqual({
      deviceId: { ideal: "dev-42" },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: true,
    });
  });
});
