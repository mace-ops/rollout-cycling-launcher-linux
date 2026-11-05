import type { AppId, Overrides, Snapshot } from '../shared/api';

export type Screen =
  | 'library' | 'setup' | 'progress' | 'done' | 'launching' | 'running' | 'bterror' | 'crash' | 'failed'
  | 'bluetooth' | 'appmenu' | 'settings' | 'help' | 'remove' | 'gate' | 'advanced';

export type AdvTab = AppId | 'bluetooth' | 'launcher';

/** State that concerns only the UI. Everything domain-related comes from the snapshot. */
export interface Ui {
  screen: Screen;
  setupApp: AppId;
  setupSteam: boolean;
  hd: boolean;
  updateDone: boolean;
  launchApp: AppId;
  /** App whose menu (gear on the card) is open */
  menuApp: AppId;
  btHelp: boolean;
  reportDone: boolean;
  steamModal: boolean;
  /** Desired state while the dialog "Steam has to restart" is open for Rollout */
  steamRollout: boolean | null;
  /** Own selection list instead of the native menu so controller and touch can operate it */
  picker: { id: string; title: string; options: { label: string; selected: boolean }[] } | null;
  confirmRemove: AppId | null;
  confirmQuit: boolean;
  /** Dialog "Restart Rollout?" */
  confirmRestart: boolean;
  /** Dialog "Start version x?" (previous version) */
  confirmPrevious: boolean;
  /** Consent dialog "Download the Zwift image?" (only when Zwift is installed for real) */
  confirmImage: boolean;
  gatePassed: boolean;
  advTab: AdvTab;
}

export const freshUi = (): Ui => ({
  screen: 'library', setupApp: 'mywhoosh', setupSteam: true, hd: false, updateDone: false,
  launchApp: 'mywhoosh', menuApp: 'mywhoosh', btHelp: false, reportDone: false, steamModal: false, steamRollout: null, picker: null, confirmRemove: null, confirmQuit: false, confirmRestart: false, confirmPrevious: false, confirmImage: false,
  gatePassed: false, advTab: 'mywhoosh'
});

export const LAUNCH_SCREENS: readonly Screen[] = ['launching', 'running', 'bterror', 'crash', 'failed'];

/** Where "Back" leads, also for Esc and the B button. `null`: no back. */
export const BACK: Partial<Record<Screen, Screen>> = {
  setup: 'library', progress: 'library', done: 'library', bluetooth: 'appmenu', appmenu: 'library', settings: 'library',
  help: 'settings', remove: 'settings', gate: 'settings', advanced: 'settings'
};

export const isCustom = (o: Overrides): boolean => o.mode === 'custom' || o.graphics !== 'auto';

export const anyCustom = (snap: Snapshot): boolean => Object.values(snap.overrides).some(isCustom) || snap.updateChannel !== 'stable';
