import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import ar from "./locales/ar.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import hi from "./locales/hi.json";
import id from "./locales/id.json";
import pt from "./locales/pt.json";
import ru from "./locales/ru.json";
import sw from "./locales/sw.json";
import ne from "./locales/ne.json";
import bn from "./locales/bn.json";
import ur from "./locales/ur.json";
import fa from "./locales/fa.json";
import th from "./locales/th.json";

// UI languages the chrome can render in. `dir` drives full RTL mirroring:
// document.dir, the MUI theme direction, and the emotion RTL cache all key
// off it (see main.tsx). Adding a language = add a locale JSON + a row here.
export interface UiLanguage {
  code: string;
  /** Native name, shown in the switcher. */
  label: string;
  dir: "ltr" | "rtl";
}

export const UI_LANGUAGES: UiLanguage[] = [
  { code: "en", label: "English", dir: "ltr" },
  { code: "ar", label: "العربية", dir: "rtl" },
  { code: "es", label: "Español", dir: "ltr" },
  { code: "fr", label: "Français", dir: "ltr" },
  { code: "hi", label: "हिन्दी", dir: "ltr" },
  { code: "id", label: "Bahasa Indonesia", dir: "ltr" },
  { code: "pt", label: "Português", dir: "ltr" },
  { code: "ru", label: "Русский", dir: "ltr" },
  { code: "sw", label: "Kiswahili", dir: "ltr" },
  { code: "ne", label: "नेपाली", dir: "ltr" },
  { code: "bn", label: "বাংলা", dir: "ltr" },
  { code: "ur", label: "اردو", dir: "rtl" },
  { code: "fa", label: "فارسی", dir: "rtl" },
  { code: "th", label: "ไทย", dir: "ltr" },
];

const UI_LANG_KEY = "be:uiLang";

export function loadInitialUiLang(): string {
  try {
    const raw = localStorage.getItem(UI_LANG_KEY);
    if (raw && UI_LANGUAGES.some((l) => l.code === raw)) return raw;
  } catch {
    /* ignore */
  }
  return "en";
}

export function persistUiLang(code: string): void {
  try {
    localStorage.setItem(UI_LANG_KEY, code);
  } catch {
    /* ignore */
  }
}

export function dirForLang(code: string): "ltr" | "rtl" {
  return UI_LANGUAGES.find((l) => l.code === code)?.dir ?? "ltr";
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ar: { translation: ar },
    es: { translation: es },
    fr: { translation: fr },
    hi: { translation: hi },
    id: { translation: id },
    pt: { translation: pt },
    ru: { translation: ru },
    sw: { translation: sw },
    ne: { translation: ne },
    bn: { translation: bn },
    ur: { translation: ur },
    fa: { translation: fa },
    th: { translation: th },
  },
  lng: loadInitialUiLang(),
  fallbackLng: "en",
  interpolation: {
    // React already escapes; double-escaping corrupts Arabic quotes.
    escapeValue: false,
  },
  returnEmptyString: false,
});

export default i18n;
