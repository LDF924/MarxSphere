import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type SupportedLanguage = "zh" | "en";
export type LanguagePreference = "auto" | SupportedLanguage;

const LANGUAGE_STORAGE_KEY = "sag:language-preference:v1";

type I18nContextValue = {
  language: SupportedLanguage;
  preference: LanguagePreference;
  setPreference: (preference: LanguagePreference) => void;
  t: (zh: string, en: string) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function useLanguageController(): I18nContextValue {
  const [preference, setPreferenceState] = useState<LanguagePreference>(() => loadStoredLanguagePreference());
  const [browserLanguage, setBrowserLanguage] = useState<SupportedLanguage>(() => detectBrowserLanguage());
  const language = preference === "auto" ? browserLanguage : preference;

  useEffect(() => {
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  }, [language]);

  useEffect(() => {
    const refreshBrowserLanguage = () => setBrowserLanguage(detectBrowserLanguage());
    window.addEventListener("languagechange", refreshBrowserLanguage);
    return () => window.removeEventListener("languagechange", refreshBrowserLanguage);
  }, []);

  const setPreference = (nextPreference: LanguagePreference) => {
    setPreferenceState(nextPreference);
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, nextPreference);
  };

  return useMemo(() => ({
    language,
    preference,
    setPreference,
    t: (zh: string, en: string) => translate(language, zh, en)
  }), [language, preference]);
}

export function I18nProvider({ value, children }: { value: I18nContextValue; children: ReactNode }) {
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within I18nProvider");
  }
  return context;
}

export function translate(language: SupportedLanguage, zh: string, en: string) {
  return language === "en" ? en : zh;
}

export function detectBrowserLanguage(): SupportedLanguage {
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  return languages.some((language) => language.toLowerCase().startsWith("zh")) ? "zh" : "en";
}

function loadStoredLanguagePreference(): LanguagePreference {
  const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  return stored === "zh" || stored === "en" || stored === "auto" ? stored : "auto";
}
