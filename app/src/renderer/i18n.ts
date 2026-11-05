import { de } from './locales/de';
import { en, type MessageKey, type Messages } from './locales/en';
import { es } from './locales/es';
import { fr } from './locales/fr';
import { it } from './locales/it';
import { nl } from './locales/nl';
import { pl } from './locales/pl';
import { pt } from './locales/pt';

/** More languages: create a file under locales/ and register it here. The `Messages` type enforces all keys. */
const CATALOGS: Record<string, Messages> = { en, de, es, fr, it, pt, nl, pl };

export const LANGUAGES: readonly string[] = Object.keys(CATALOGS);
export const languageName = (code: string): string => CATALOGS[code]?.['lang.name'] ?? code;

let current = 'en';

/** `choice` is "auto" or a language code, `system` the system language, e.g. "de-DE". */
export function resolveLanguage(choice: string, system: string): string {
  if (choice !== 'auto' && CATALOGS[choice]) return choice;
  const base = system.toLowerCase().split(/[-_]/)[0];
  return CATALOGS[base] ? base : 'en';
}

export function setLanguage(code: string): void {
  current = CATALOGS[code] ? code : 'en';
  document.documentElement.lang = current;
}

export const language = (): string => current;

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** Translates a key. Values in `params` are escaped, the text itself is not. */
export function t(key: MessageKey, params: Record<string, string | number> = {}): string {
  const text = CATALOGS[current][key] ?? en[key];
  return text.replace(/\{(\w+)\}/g, (_match, name: string) => (name in params ? escapeHtml(String(params[name])) : `{${name}}`));
}

export const formatNumber = (n: number): string =>
  new Intl.NumberFormat(current, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n);
