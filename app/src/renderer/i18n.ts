import { de } from './locales/de';
import { en, type MessageKey, type Messages } from './locales/en';
import { es } from './locales/es';
import { fr } from './locales/fr';
import { it } from './locales/it';
import { nl } from './locales/nl';
import { pl } from './locales/pl';
import { pt } from './locales/pt';

/** Weitere Sprachen: Datei unter locales/ anlegen und hier eintragen. Der Typ `Messages` erzwingt alle Schlüssel. */
const CATALOGS: Record<string, Messages> = { en, de, es, fr, it, pt, nl, pl };

export const LANGUAGES: readonly string[] = Object.keys(CATALOGS);
export const languageName = (code: string): string => CATALOGS[code]?.['lang.name'] ?? code;

let current = 'en';

/** `choice` ist „auto“ oder ein Sprachcode, `system` die Sprache des Systems, etwa „de-DE“. */
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

/** Übersetzt einen Schlüssel. Werte in `params` werden escaped, der Text selbst nicht. */
export function t(key: MessageKey, params: Record<string, string | number> = {}): string {
  const text = CATALOGS[current][key] ?? en[key];
  return text.replace(/\{(\w+)\}/g, (_match, name: string) => (name in params ? escapeHtml(String(params[name])) : `{${name}}`));
}

export const formatNumber = (n: number): string =>
  new Intl.NumberFormat(current, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n);
