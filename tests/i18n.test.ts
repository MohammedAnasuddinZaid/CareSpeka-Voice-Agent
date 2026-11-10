import { describe, expect, it, vi } from "vitest";
import {
  getUiLanguageSnapshot,
  I18N_LANGUAGES,
  notifyUiLanguageChanged,
  subscribeUiLanguage,
  t,
  type UIKey,
} from "@/lib/i18n";
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from "@/types";

const UI_KEYS: UIKey[] = [
  "appName",
  "handMode",
  "eyeMode",
  "cctv",
  "nurse",
  "ward",
  "logs",
  "report",
  "about",
  "emergency",
  "startCamera",
  "stopCamera",
  "cameraPermissionHint",
  "loadingModel",
  "downloadingWasm",
  "waitingGesture",
  "gestureDetected",
  "confidenceLabel",
  "faceDetected",
  "noFace",
  "noHand",
  "handsDetected",
  "paused",
  "voiceAlertsActive",
  "replayLastAlert",
  "gestureGuide",
  "demoMode",
  "demoModeActive",
  "sessionShare",
  "copyUrl",
  "copied",
  "live",
  "reconnecting",
  "disconnected",
  "nurseReplyTitle",
  "sendMessage",
  "onMyWay",
  "pleaseWait",
  "doctorNotified",
  "acknowledge",
  "escalate",
  "resolve",
  "pending",
  "autoEscalated",
];

const ALL_LANGS = Object.keys(SUPPORTED_LANGUAGES) as SupportedLanguage[];

describe("i18n dictionaries", () => {
  it("exposes exactly the supported languages", () => {
    expect(I18N_LANGUAGES).toEqual(ALL_LANGS);
  });

  it("has a non-empty translation for every key in every language", () => {
    for (const lang of ALL_LANGS) {
      for (const key of UI_KEYS) {
        const value = t(lang, key);
        expect(value, `${lang}.${key}`).toBeTruthy();
        expect(value.trim(), `${lang}.${key}`).not.toBe("");
      }
    }
  });

  it("actually translates the app name per language", () => {
    expect(t("en-US", "appName")).toBe("CareSpeak");
    // Hindi should not silently fall back to the English name.
    expect(t("hi-IN", "appName")).not.toBe(t("en-US", "appName"));
    expect(t("ta-IN", "nurse")).not.toBe("Nurse");
  });

  it("falls back to English for an unknown language code", () => {
    expect(t("xx-YY", "nurse")).toBe("Nurse");
    expect(t("xx-YY", "appName")).toBe("CareSpeak");
  });
});

describe("reactive language store", () => {
  it("returns the English snapshot when there is no browser", () => {
    expect(getUiLanguageSnapshot()).toBe("en-US");
  });

  it("notifies subscribers and unsubscribes cleanly", () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = subscribeUiLanguage(first);
    const offSecond = subscribeUiLanguage(second);

    notifyUiLanguageChanged();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    offFirst();
    notifyUiLanguageChanged();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);

    offSecond();
    // Removing twice must be harmless.
    offSecond();
    notifyUiLanguageChanged();
    expect(second).toHaveBeenCalledTimes(2);
  });
});