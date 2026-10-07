import type { LocaleCode } from "./locales.ts";
import { en, th, zhCN, type Messages } from "./messages.ts";

export * from "./locales.ts";
export type { Messages } from "./messages.ts";

const DICTIONARIES: Record<LocaleCode, Messages> = {
  th,
  en,
  "zh-CN": zhCN,
};

export function getMessages(code: LocaleCode): Messages {
  return DICTIONARIES[code];
}
