/**
 * 学习设置读写（localStorage 持久化）
 * 目标记忆保持率默认 90%，可调整并即时作用于 FSRS 调度器
 */
import type { StudySettings } from "@/types";

const KEY = "yanyu-1000:settings";

const defaultSettings: StudySettings = {
  dailyNewCount: 20,
  requestRetention: 0.9,
};

export function loadSettings(): StudySettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...defaultSettings };
    const parsed = JSON.parse(raw) as Partial<StudySettings>;
    return {
      dailyNewCount:
        typeof parsed.dailyNewCount === "number" && parsed.dailyNewCount > 0
          ? parsed.dailyNewCount
          : defaultSettings.dailyNewCount,
      requestRetention:
        typeof parsed.requestRetention === "number" &&
        parsed.requestRetention > 0.5 &&
        parsed.requestRetention <= 1
          ? parsed.requestRetention
          : defaultSettings.requestRetention,
    };
  } catch {
    return { ...defaultSettings };
  }
}

export function saveSettings(settings: StudySettings): void {
  localStorage.setItem(KEY, JSON.stringify(settings));
}
