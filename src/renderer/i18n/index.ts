export const SUPPORTED_LANGUAGES = ["en", "ja", "zh"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const LANGUAGE_NAMES: Record<SupportedLanguage, string> = {
  en: "English",
  ja: "日本語",
  zh: "中文（简体）",
};

export function applyPersistedLanguage(_lang?: string): void {
  // Language packs are present for tests/documentation, but the runtime no
  // longer depends on i18next in this package state.
}

export async function changeLanguage(lang: SupportedLanguage): Promise<void> {
  try {
    if (typeof window !== "undefined" && window.electronAPI?.saveAppearanceSettings) {
      await window.electronAPI.saveAppearanceSettings({ language: lang });
    }
  } catch {
    // Non-critical; the UI can continue with the current language.
  }
}
