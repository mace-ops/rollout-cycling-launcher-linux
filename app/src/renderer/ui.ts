import type { AppId, Overrides, Snapshot } from '../shared/api';

export type Screen =
  | 'library' | 'setup' | 'progress' | 'done' | 'launching' | 'running' | 'bterror' | 'crash'
  | 'bluetooth' | 'settings' | 'help' | 'remove' | 'gate' | 'advanced';

export type AdvTab = AppId | 'bluetooth' | 'launcher';

/** Zustand, der nur die Oberfläche betrifft. Alles Fachliche kommt aus dem Snapshot. */
export interface Ui {
  screen: Screen;
  setupApp: AppId;
  setupSteam: boolean;
  hd: boolean;
  updateDone: boolean;
  launchApp: AppId;
  btHelp: boolean;
  reportDone: boolean;
  steamModal: boolean;
  /** Gewünschter Zustand, solange der Dialog „Steam muss neu starten“ für Rollout offen ist */
  steamRollout: boolean | null;
  /** Eigene Auswahlliste statt des nativen Menüs, damit Controller und Touch sie bedienen können */
  picker: { id: string; title: string; options: { label: string; selected: boolean }[] } | null;
  confirmRemove: AppId | null;
  confirmQuit: boolean;
  /** Dialog „Rollout neu starten?“ */
  confirmRestart: boolean;
  /** Dialog „Version x starten?“ (vorherige Version) */
  confirmPrevious: boolean;
  gatePassed: boolean;
  advTab: AdvTab;
}

export const freshUi = (): Ui => ({
  screen: 'library', setupApp: 'mywhoosh', setupSteam: true, hd: false, updateDone: false,
  launchApp: 'mywhoosh', btHelp: false, reportDone: false, steamModal: false, steamRollout: null, picker: null, confirmRemove: null, confirmQuit: false, confirmRestart: false, confirmPrevious: false,
  gatePassed: false, advTab: 'mywhoosh'
});

export const LAUNCH_SCREENS: readonly Screen[] = ['launching', 'running', 'bterror', 'crash'];

/** Wohin „Zurück“ führt, auch für Esc und die B-Taste. `null`: kein Zurück. */
export const BACK: Partial<Record<Screen, Screen>> = {
  setup: 'library', progress: 'library', done: 'library', bluetooth: 'library', settings: 'library',
  help: 'settings', remove: 'settings', gate: 'settings', advanced: 'settings'
};

export const isCustom = (o: Overrides): boolean => o.mode === 'custom' || o.graphics !== 'auto';

export const anyCustom = (snap: Snapshot): boolean => Object.values(snap.overrides).some(isCustom) || snap.updateChannel !== 'stable';
