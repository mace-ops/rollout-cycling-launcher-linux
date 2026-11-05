import type { AppId, LaunchPhase, RolloutApi, Snapshot } from '../shared/api';
import { resolveLanguage, setLanguage } from './i18n';
import { focusInitial, initNav } from './nav';
import { BACK, LAUNCH_SCREENS, freshUi, type AdvTab, type Screen, type Ui } from './ui';
import { cardStatus, launchText, modal, noticeVisible, phasesHtml, scanHtml, selfUpdateNote, view } from './views';

declare global {
  interface Window { rollout: RolloutApi }
}

const api = window.rollout;
const $ = (id: string): HTMLElement | null => document.getElementById(id);
const root = $('root') as HTMLElement;
const viewEl = $('view') as HTMLElement;
const stageEl = $('stage') as HTMLElement;

const ui: Ui = freshUi();
let snap: Snapshot;
let shownScreen: Screen | null = null;
let shownStage: string | null = null;
let renderedKey = '';
let hadModal = false;
let opener: string | null = null;
let pendingOpener: string | null = null;
let seenFinished = 0;
const patched = new Map<string, string>();

const sceneImg = (id: AppId): string => `<img class="scene" data-app="${id}" src="assets/img/${id}.jpg" alt="">`;
const isAppTab = (tab: AdvTab): tab is AppId => tab === 'mywhoosh' || tab === 'zwift';

const screenForPhase = (phase: LaunchPhase): Screen =>
  phase === 'running' ? 'running' : phase === 'bterror' ? 'bterror' : phase === 'crash' ? 'crash' : phase === 'failed' ? 'failed' : 'launching';

/** Alles, was die Ansicht neu zeichnen muss. Fortschritt, Suchergebnisse und Starttext nicht. */
function structKey(): string {
  const { progress: _progress, ...selfUpdate } = snap.selfUpdate;
  return JSON.stringify([
    ui.screen, ui.steamModal, ui.steamRollout, ui.picker, ui.confirmRemove, ui.confirmQuit, ui.confirmRestart, ui.confirmPrevious, ui.confirmImage, snap.zwiftTag, snap.updateChannel, selfUpdate, snap.apps, snap.job && [snap.job.app, snap.job.kind],
    snap.launch && [screenForPhase(snap.launch.phase), snap.launch.problem, snap.launch.phase === 'stopping'], snap.bluetooth, snap.autoUpdate, snap.rolloutSteam, snap.overrides, snap.language, snap.theme, snap.scale
  ]);
}

// Die Bühne liegt außerhalb von #view und läuft bei jedem Neuaufbau ungestört weiter.
function updateStage(): void {
  const app = ui.screen === 'setup' || ui.screen === 'progress' || ui.screen === 'done' ? ui.setupApp
    : LAUNCH_SCREENS.includes(ui.screen) ? ui.launchApp : null;
  const key = ui.screen === 'library' ? 'none' : app ?? 'neutral';
  const clear = ui.screen === 'launching' || ui.screen === 'running';
  stageEl.classList.toggle('clear', clear);
  stageEl.classList.toggle('kb', clear);
  root.dataset.tone = app ?? 'neutral';
  if (key === shownStage) return;
  shownStage = key;
  stageEl.innerHTML = key === 'none' ? '' : `<div>${app ? sceneImg(app) : '<div class="mesh"></div><div class="grain"></div>'}</div>`;
}

function setBar(id: string, pct: number): void {
  const el = $(id);
  if (el) el.style.width = `${pct}%`;
}

function applyWidths(): void {
  viewEl.querySelectorAll<HTMLElement>('[data-w]').forEach((el) => { el.style.width = `${el.dataset.w}%`; });
}

const elementKey = (el: Element | null): string | null => {
  if (!(el instanceof HTMLElement)) return null;
  if (el.id) return `id:${el.id}`;
  return [el.dataset.act, el.dataset.arg, el.dataset.change, el.id, el.textContent?.trim()].join('|');
};

const findByKey = (key: string): HTMLElement | undefined =>
  [...viewEl.querySelectorAll<HTMLElement>('button,input,select')].find((el) => elementKey(el) === key);

function render(): void {
  updateStage();
  const changed = shownScreen !== ui.screen;
  const modalHtml = modal(ui, snap);
  const hasModal = modalHtml !== '';
  const focusKey = changed ? null : elementKey(document.activeElement);
  if (hasModal && !hadModal) opener = pendingOpener ?? elementKey(document.activeElement);
  pendingOpener = null;
  viewEl.innerHTML = `<div class="${changed ? 'screen' : ''}">${view(ui, snap)}</div>${modalHtml}`;
  applyWidths();
  patched.clear();
  if (changed) window.scrollTo(0, 0);
  shownScreen = ui.screen;
  renderedKey = structKey();

  const dialog = viewEl.querySelector('.modalbg');
  if (hasModal && dialog) {
    if (!hadModal) focusInitial(dialog);
    else (findByKey(focusKey ?? '') ?? undefined)?.focus();
  } else if (hadModal) {
    (opener ? findByKey(opener) : undefined)?.focus();
    opener = null;
  } else if (changed) {
    focusInitial(viewEl);
  } else if (focusKey) {
    findByKey(focusKey)?.focus();
  }
  hadModal = hasModal;
}

function setHtml(id: string, html: string): void {
  const el = $(id);
  if (!el || patched.get(id) === html) return;
  patched.set(id, html);
  el.innerHTML = html;
}

/** Der Takt aktualisiert nur einzelne Elemente, damit Klicks nicht verloren gehen und Animationen nicht neu starten. */
function patch(): void {
  const job = snap.job;
  if (job) {
    const pct = $('pct');
    if (pct) pct.textContent = `${job.progress} %`;
    setBar('bar', job.progress);
    setBar('cardbar', job.progress);
    setHtml('phases', phasesHtml(snap));
    const status = $(`status-${job.app}`);
    if (status) status.textContent = cardStatus(job.app, snap);
  }
  if (snap.launch) {
    const text = $('launchText');
    if (text) text.textContent = launchText(snap.launch.phase, snap.launch.app);
    setBar('launchBar', snap.launch.progress);
  }
  setHtml('scan', scanHtml(snap));
  if (snap.selfUpdate.status === 'downloading') {
    setHtml('su-note', selfUpdateNote(snap));
    setBar('su-bar', snap.selfUpdate.progress);
  }
}

function onSnapshot(next: Snapshot): void {
  snap = next;
  theme = snap.theme;
  applyScheme();
  setLanguage(resolveLanguage(snap.language, snap.systemLocale));
  if (snap.finished && snap.finished.seq !== seenFinished) {
    seenFinished = snap.finished.seq;
    if (ui.screen === 'progress') {
      ui.setupApp = snap.finished.app;
      ui.updateDone = snap.finished.kind === 'update';
      ui.screen = 'done';
    }
  }
  if (snap.launch) {
    if (LAUNCH_SCREENS.includes(ui.screen)) ui.screen = screenForPhase(snap.launch.phase);
  } else if (LAUNCH_SCREENS.includes(ui.screen)) {
    ui.screen = 'library';
  }
  if (!snap.job && ui.screen === 'progress') {
    // Eine gescheiterte Installation zeigt ihren Grund dort, wo man es noch einmal versuchen kann.
    const info = snap.apps[ui.setupApp];
    ui.screen = info.problem && !info.installed ? 'setup' : 'library';
  }
  if (renderedKey !== structKey()) render();
  else patch();
}

function startLaunch(id: AppId, options?: { ignoreBluetooth?: boolean; safe?: boolean }): void {
  ui.launchApp = id;
  ui.screen = 'launching';
  void api.launch(id, options);
}

type Action = (arg: string) => void;
const ACTIONS: Record<string, Action> = {
  go(arg) {
    ui.screen = arg as Screen;
    if (arg === 'bluetooth') { ui.btHelp = false; void api.scanBluetooth(); }
    if (arg === 'help') ui.reportDone = false;
  },
  card(arg) {
    const id = arg as AppId;
    const info = snap.apps[id];
    if (snap.job?.app === id) { ui.screen = 'progress'; ui.setupApp = id; }
    else if (info.installed && info.updateAvailable) { ui.screen = 'progress'; ui.setupApp = id; void api.startUpdate(id); }
    else if (info.installed) startLaunch(id);
    else Object.assign(ui, { screen: 'setup', setupApp: id, hd: false, setupSteam: true });
  },
  hd() { ui.hd = !ui.hd; },
  install() {
    // Echtes Zwift lädt ein mehrere GB großes Image: erst fragen, mit Tag und Größe.
    if (ui.setupApp === 'zwift' && snap.zwiftTag) { ui.confirmImage = true; return; }
    ACTIONS.imageConfirm('');
  },
  imageConfirm() {
    ui.confirmImage = false;
    void api.install(ui.setupApp, { steam: ui.setupSteam, hd: ui.hd });
    ui.screen = 'progress';
  },
  launch(arg) { startLaunch(arg as AppId); },
  ignoreBt() { startLaunch(ui.launchApp, { ignoreBluetooth: true }); },
  safeStart() { startLaunch(ui.launchApp, { ignoreBluetooth: true, safe: true }); },
  stopLaunch() { void api.stopLaunch(); ui.screen = 'library'; },
  repair() { void api.scanBluetooth(); },
  btHelp() { ui.btHelp = !ui.btHelp; },
  auto() { void api.setAutoUpdate(!snap.autoUpdate); },
  steam(arg) { const id = arg as AppId; void api.setSteam(id, !snap.apps[id].steam); ui.steamModal = true; },
  closeModal() { ui.steamModal = false; ui.steamRollout = null; ui.confirmRemove = null; ui.picker = null; ui.confirmQuit = false; ui.confirmRestart = false; ui.confirmPrevious = false; ui.confirmImage = false; },
  suAsk() { ui.confirmRestart = true; },
  suRestartNow() { ui.confirmRestart = false; void api.restartForUpdate(); },
  suCheck() { void api.checkSelfUpdate(); },
  suDownload() { void api.downloadSelfUpdate(); },
  suCancel() { void api.cancelSelfUpdate(); },
  suNoticeOk() { void api.dismissUpdateNotice(); },
  prevAsk() { ui.confirmPrevious = true; },
  prevNow() { ui.confirmPrevious = false; void api.startPreviousVersion(); },
  quit() { ui.confirmQuit = true; },
  quitConfirm() { api.quit(); },
  pick(arg) {
    const picker = ui.picker;
    ui.picker = null;
    const select = picker && viewEl.querySelector<HTMLSelectElement>(`#${picker.id}`);
    if (!select) return;
    select.selectedIndex = Number(arg);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  },
  rolloutSteam() {
    const on = snap.rolloutSteam.state !== 'in';
    void api.setRolloutInSteam(on, false).then((result) => {
      if (result === 'steam-running') { ui.steamRollout = on; render(); }
    });
  },
  steamRestartNow() {
    const on = ui.steamRollout ?? true;
    ui.steamRollout = null;
    void api.setRolloutInSteam(on, true);
  },
  report() { void api.createReport(); ui.reportDone = true; },
  remove(arg) { ui.confirmRemove = arg as AppId; },
  removeConfirm(arg) { void api.remove(arg as AppId); ui.confirmRemove = null; },
  advanced() { ui.screen = ui.gatePassed ? 'advanced' : 'gate'; },
  passGate() { ui.screen = 'advanced'; ui.gatePassed = true; },
  tab(arg) { ui.advTab = arg as AdvTab; },
  resetAll() { void api.resetOverrides(); }
};

type Change = (el: HTMLInputElement | HTMLSelectElement) => void;
const CHANGES: Record<string, Change> = {
  setupSteam(el) { ui.setupSteam = (el as HTMLInputElement).checked; },
  protonRec() { if (isAppTab(ui.advTab)) void api.setOverrides(ui.advTab, { mode: 'rec' }); },
  protonCustom() { if (isAppTab(ui.advTab)) void api.setOverrides(ui.advTab, { mode: 'custom' }); },
  version(el) { if (isAppTab(ui.advTab)) void api.setOverrides(ui.advTab, { version: el.value }); },
  language(el) { void api.setLanguage(el.value); },
  channel(el) { void api.setUpdateChannel(el.value as Snapshot['updateChannel']); },
  scale(el) { void api.setScale(el.value); },
  theme(el) { void api.setTheme(el.value as Snapshot['theme']); },
  graphics(el) { if (isAppTab(ui.advTab)) void api.setOverrides(ui.advTab, { graphics: el.value as 'auto' | 'wayland' | 'x11' }); }
};

viewEl.addEventListener('click', (event) => {
  const el = (event.target as Element).closest<HTMLButtonElement>('button[data-act]');
  if (!el || el.disabled || !ACTIONS[el.dataset.act ?? '']) return;
  ACTIONS[el.dataset.act as string](el.dataset.arg ?? '');
  render();
});
/** Native Auswahlmenüs sind mit Controller und Touch im Gaming Mode nicht bedienbar: Rollout zeigt stattdessen eine eigene Liste. */
function openPicker(select: HTMLSelectElement): void {
  const label = document.querySelector(`label[for="${select.id}"]`);
  const title = select.getAttribute('aria-label') ?? label?.querySelector('span')?.textContent ?? label?.textContent ?? '';
  pendingOpener = `id:${select.id}`;
  ui.picker = {
    id: select.id,
    title: title.trim(),
    options: [...select.options].map((o) => ({ label: o.textContent ?? '', selected: o.selected }))
  };
  render();
}
viewEl.addEventListener('mousedown', (event) => {
  if ((event.target as Element).closest('select')) event.preventDefault();
});
viewEl.addEventListener('click', (event) => {
  const select = (event.target as Element).closest('select');
  if (select && !select.disabled && select.id) openPicker(select);
});
viewEl.addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof HTMLSelectElement && event.target.id) {
    event.preventDefault();
    openPicker(event.target);
  }
});
viewEl.addEventListener('change', (event) => {
  const el = event.target as HTMLInputElement | HTMLSelectElement;
  const fn = CHANGES[el.dataset.change ?? ''];
  if (!fn) return;
  fn(el);
  render();
});

/** Esc und die B-Taste: erst den Dialog schließen, sonst eine Ebene zurück. */
function back(): void {
  if (ui.steamModal || ui.steamRollout !== null || ui.confirmRemove || ui.picker || ui.confirmQuit || ui.confirmRestart || ui.confirmPrevious || ui.confirmImage) {
    ACTIONS.closeModal('');
  } else if (noticeVisible(ui, snap)) {
    ACTIONS.suNoticeOk('');
  } else if (ui.screen === 'launching' || ui.screen === 'bterror' || ui.screen === 'crash' || ui.screen === 'failed') {
    ACTIONS.stopLaunch('');
  } else {
    const target = BACK[ui.screen];
    if (!target) return;
    ui.screen = target;
  }
  render();
}

// Hell und Dunkel folgen der Systemeinstellung.
const scheme = window.matchMedia('(prefers-color-scheme: light)');
let theme: Snapshot['theme'] = 'dark';
const applyScheme = (): void => {
  const light = theme === 'light' || (theme === 'auto' && scheme.matches);
  root.classList.toggle('light', light);
  document.documentElement.classList.toggle('light', light);
};
applyScheme();
scheme.addEventListener('change', applyScheme);

initNav({
  scope: () => viewEl.querySelector('.modalbg') ?? viewEl,
  modalOpen: () => !!viewEl.querySelector('.modalbg'),
  back
});

void api.getSnapshot().then((first) => {
  snap = first;
  theme = snap.theme;
  applyScheme();
  setLanguage(resolveLanguage(snap.language, snap.systemLocale));
  seenFinished = first.finished?.seq ?? 0;
  api.onSnapshot(onSnapshot);
  render();
  // Gesund-Meldung an den Wächter, sobald die Oberfläche das erste Mal gezeichnet ist.
  requestAnimationFrame(() => requestAnimationFrame(() => api.uiReady()));
});
