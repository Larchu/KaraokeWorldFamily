export type ApplauseDurationSec = 5 | 10 | 15;

export interface AppSettings {
  micDeviceId: string;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  applauseDurationSec: ApplauseDurationSec;
  stageVoiceFallback: boolean;
  reducedEffects: boolean;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  micDeviceId: "",
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: false,
  applauseDurationSec: 10,
  stageVoiceFallback: true,
  reducedEffects: false,
};

const STORAGE_KEY = "pm-app-settings";
const SETTINGS_EVENT = "pm-settings-changed";

export function normalizeAppSettings(raw: unknown): AppSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_APP_SETTINGS };
  const obj = raw as Record<string, unknown>;
  const dur = obj["applauseDurationSec"];
  const validDuration: ApplauseDurationSec = dur === 5 || dur === 10 || dur === 15 ? dur : 10;
  return {
    micDeviceId: typeof obj["micDeviceId"] === "string" ? obj["micDeviceId"].slice(0, 200) : "",
    echoCancellation:
      typeof obj["echoCancellation"] === "boolean"
        ? obj["echoCancellation"]
        : DEFAULT_APP_SETTINGS.echoCancellation,
    noiseSuppression:
      typeof obj["noiseSuppression"] === "boolean"
        ? obj["noiseSuppression"]
        : DEFAULT_APP_SETTINGS.noiseSuppression,
    autoGainControl:
      typeof obj["autoGainControl"] === "boolean"
        ? obj["autoGainControl"]
        : DEFAULT_APP_SETTINGS.autoGainControl,
    applauseDurationSec: validDuration,
    stageVoiceFallback:
      typeof obj["stageVoiceFallback"] === "boolean"
        ? obj["stageVoiceFallback"]
        : DEFAULT_APP_SETTINGS.stageVoiceFallback,
    reducedEffects:
      typeof obj["reducedEffects"] === "boolean"
        ? obj["reducedEffects"]
        : DEFAULT_APP_SETTINGS.reducedEffects,
  };
}

export function loadAppSettings(): AppSettings {
  try {
    if (typeof window === "undefined") return { ...DEFAULT_APP_SETTINGS };
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_APP_SETTINGS };
    return normalizeAppSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_APP_SETTINGS };
  }
}

export function saveAppSettings(patch: Partial<AppSettings>): AppSettings {
  const next = normalizeAppSettings({ ...loadAppSettings(), ...patch });
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      window.dispatchEvent(new CustomEvent(SETTINGS_EVENT, { detail: next }));
    }
  } catch {
    /* ignore */
  }
  return next;
}

export function resetAppSettings(): AppSettings {
  const next = { ...DEFAULT_APP_SETTINGS };
  try {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(STORAGE_KEY);
      window.dispatchEvent(new CustomEvent(SETTINGS_EVENT, { detail: next }));
    }
  } catch {
    /* ignore */
  }
  return next;
}

export function subscribeAppSettings(cb: (settings: AppSettings) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onCustom = (e: Event) => {
    const ce = e as CustomEvent<AppSettings>;
    cb(ce.detail ?? loadAppSettings());
  };
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) cb(loadAppSettings());
  };
  window.addEventListener(SETTINGS_EVENT, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(SETTINGS_EVENT, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}

export function buildAudioConstraints(
  settings: Pick<
    AppSettings,
    "micDeviceId" | "echoCancellation" | "noiseSuppression" | "autoGainControl"
  >,
): MediaTrackConstraints {
  const base: MediaTrackConstraints = {
    echoCancellation: settings.echoCancellation,
    noiseSuppression: settings.noiseSuppression,
    autoGainControl: settings.autoGainControl,
  };
  if (settings.micDeviceId) {
    base.deviceId = { ideal: settings.micDeviceId };
  }
  return base;
}

export function isEmbeddedIframe(): boolean {
  try {
    return typeof window !== "undefined" && window.self !== window.top;
  } catch {
    return true;
  }
}

export function isMicrophoneAllowedByPolicy(): boolean | null {
  try {
    if (typeof document === "undefined") return null;
    const doc = document as Document & {
      featurePolicy?: { allowsFeature?: (name: string) => boolean };
      permissionsPolicy?: { allowsFeature?: (name: string) => boolean };
    };
    const policy = doc.permissionsPolicy ?? doc.featurePolicy;
    if (policy && typeof policy.allowsFeature === "function") {
      return policy.allowsFeature("microphone");
    }
    return null;
  } catch {
    return null;
  }
}
