import { createContext } from "react";

// UI-chrome language (distinct from the *content* languages — source/target
// Bibles and notes keep their own per-field directions regardless of what
// the chrome renders in).
export interface UiLangContextValue {
  lang: string;
  setLang: (code: string) => void;
}

export const UiLangContext = createContext<UiLangContextValue>({
  lang: "en",
  setLang: () => {},
});
