import {
  APP_IDS, APP_NAMES, PROTON_VERSIONS, RECOMMENDED_PROTON, download, space,
  type AppId, type AppProblem, type LaunchPhase, type Snapshot
} from '../shared/api';
import { formatNumber, languageName, LANGUAGES, t } from './i18n';
import type { MessageKey } from './locales/en';
import { ICON } from './icons';
import { anyCustom, isCustom, type AdvTab, type Screen, type Ui } from './ui';

const esc = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

const sceneImg = (id: AppId): string => `<img class="scene" data-app="${id}" src="assets/img/${id}.jpg" alt="">`;
// Breiten setzt die Oberfläche nach dem Zeichnen per Skript, weil die CSP keine style-Attribute erlaubt.
const width = (pct: number): string => `data-w="${pct}"`;

const versionNote = (version: string): string | null =>
  version === 'GE-Proton11-12' || version === 'GE-Proton11-11' ? t('adv.note.notRecommended')
    : version === 'GE-Proton11-8' ? t('adv.note.older') : null;

/** Satz zum Problem einer App: was passiert ist und was der Nutzer tun kann. */
export const problemText = (problem: Exclude<AppProblem, ''>): string => t(`problem.${problem}` as MessageKey);

const backBtn = (to: Screen): string =>
  `<button class="btn ghost back" data-act="go" data-arg="${to}">${ICON.back}${t('common.back')}</button>`;

const sw = (on: boolean, act: string, label: string, arg = '', disabled = false): string =>
  `<button class="switch ${on ? 'on' : ''}" role="switch" aria-checked="${on}" aria-label="${label}" data-act="${act}" data-arg="${arg}" ${disabled ? 'disabled' : ''}></button>`;

export function cardStatus(id: AppId, snap: Snapshot): string {
  const info = snap.apps[id];
  if (snap.launch?.app === id && snap.launch.phase === 'stopping') return t('status.stopping');
  if (snap.job?.app === id) return t(snap.job.kind === 'update' ? 'status.updating' : 'status.installing', { pct: snap.job.progress });
  if (info.installed && info.updateAvailable) return t('status.update');
  return info.installed ? t('status.ready') : t('status.notInstalled', { gb: download(id, false) });
}

/** Kopfzeilen-Knopf „Rollout aktualisieren“: nur wenn nichts belegt ist und das Update bereit ist oder von Hand geladen werden muss. */
const updateHint = (snap: Snapshot): 'restart' | 'settings' | null => {
  const su = snap.selfUpdate;
  if (su.blocked) return null;
  return su.status === 'ready' ? 'restart' : su.status === 'available' && !snap.autoUpdate ? 'settings' : null;
};

function library(snap: Snapshot): string {
  const hint = updateHint(snap);
  const cards = APP_IDS.map((id) => {
    const info = snap.apps[id];
    const busy = snap.job?.app === id;
    const stopping = snap.launch?.app === id && snap.launch.phase === 'stopping';
    const blocked = (!!snap.job && !busy && !info.installed) || stopping;
    const hasUpdate = info.installed && info.updateAvailable && !busy;
    const label = busy ? t('btn.progress') : hasUpdate ? t('btn.update') : info.installed ? t('btn.ride') : t('btn.install');
    const arrow = info.installed && !hasUpdate && !busy ? ICON.go : '';
    return `<article class="card onscene ${info.installed || busy ? '' : 'off'}" data-tone="${id}">
      ${sceneImg(id)}
      <div class="cardbody">
        <h2 class="cardname">${APP_NAMES[id]}</h2>
        <div class="status">
          <span class="pill ${hasUpdate || stopping ? 'warn' : info.installed ? 'ok' : ''}"><span class="dot"></span><span id="status-${id}">${cardStatus(id, snap)}</span></span>
          ${info.problem ? `<span class="pill warn" title="${esc(problemText(info.problem))}"><span class="dot"></span>${t('pill.problem')}</span>` : ''}
          ${info.installed && info.steam ? `<span class="pill">${t('pill.steam')}</span>` : ''}
          ${info.installed && isCustom(snap.overrides[id]) ? `<span class="pill warn">${t('pill.custom')}</span>` : ''}
        </div>
        ${busy ? `<div class="bar"><i id="cardbar" ${width(snap.job!.progress)}></i></div>` : ''}
        <div class="cardacts">
          <button class="btn primary" data-act="card" data-arg="${id}" ${blocked ? 'disabled' : ''}>${label}${arrow}</button>
          ${hasUpdate ? `<button class="linkbtn" data-act="launch" data-arg="${id}">${t('btn.skipUpdate')}</button>` : ''}
          ${info.installed && !busy ? `<button class="btn icon-only" data-act="appMenu" data-arg="${id}" aria-label="${t('card.options', { app: APP_NAMES[id] })}" title="${t('card.options', { app: APP_NAMES[id] })}">${ICON.gear}</button>` : ''}
        </div>
      </div>
    </article>`;
  }).join('');
  return `<div class="home onscene">
    <header class="top">
      <p class="brand">${ICON.logo}Rollout</p>
      <div class="topactions">
        ${hint ? `<button class="btn su-hint" data-act="${hint === 'restart' ? 'suAsk' : 'go'}" ${hint === 'settings' ? 'data-arg="settings"' : ''} aria-label="${t('su.hint')}" title="${t('su.hint')}"><span class="hintdot"></span>${ICON.update}<span class="su-text">${t('su.hint')}</span></button>` : ''}
        <button class="btn" data-act="go" data-arg="settings">${ICON.gear}${t('home.settings')}</button>
        <button class="btn icon-only" data-act="quit" aria-label="${t('quit.label')}" title="${t('quit.label')}">${ICON.power}</button>
      </div>
    </header>
    <main class="cards" aria-label="${t('home.apps')}">${cards}</main>
  </div>`;
}

/** Dezenter Hinweis im Zwift-Installer: Herkunft mit Link und Stand der Container-Laufzeit (✓ gefunden, ✗ fehlt, nichts bei „unbekannt“). */
function zwiftNote(runtime: string | null): string {
  const link = `<button class="linkbtn inline" data-act="project">netbrain/zwift</button>`;
  const state = runtime === null ? '' : runtime
    ? `<span class="rt ok">${ICON.check}${t('setup.runtimeOk', { name: runtime === 'docker' ? 'Docker' : 'Podman' })}</span>`
    : `<span class="rt warn">${ICON.cross}${t('setup.runtimeMissing')}</span>`;
  return `<p class="muted small">${t('setup.zwiftNote').replace('{link}', link)}</p>${state ? `<p class="muted small">${state}</p>` : ''}`;
}

function setup(ui: Ui, snap: Snapshot): string {
  const id = ui.setupApp;
  const problem = snap.apps[id].problem;
  return `<div class="page">
    ${backBtn('library')}
    <div class="split">
      <div>
        <h1 class="title">${t('setup.title', { app: APP_NAMES[id] })}</h1>
        <div class="stats">
          <div class="stat"><span>${t('setup.download')} </span><b>${t('common.gb', { n: download(id, ui.hd) })}</b></div>
          <div class="stat"><span>${t('setup.needs')} </span><b>${t('common.gb', { n: space(id, ui.hd) })}</b></div>
          ${id === 'zwift' ? '' : `<div class="stat"><span>${t('setup.takes')} </span><b>${t('common.min', { n: ui.hd ? 45 : 15 })}</b></div>`}
        </div>
      </div>
      <div>
        <div class="panel stack">
          ${problem ? `<p class="note warn" role="alert">${problemText(problem)}</p>` : ''}
          <label class="check"><input type="checkbox" data-change="setupSteam" ${ui.setupSteam ? 'checked' : ''}><span>${t('setup.steam')}</span></label>
          ${id === 'zwift' ? zwiftNote(snap.zwiftRuntime) : ''}
        </div>
        <div class="actions">
          ${id === 'mywhoosh' ? `<button class="linkbtn" data-act="hd">${ui.hd ? t('setup.hdOff', { gb: download('mywhoosh', false) }) : t('setup.hdOn', { gb: download('mywhoosh', true) })}</button>` : ''}
          <button class="btn primary push" data-act="install">${problem ? t('btn.retry') : t('btn.install')}</button>
        </div>
      </div>
    </div>
  </div>`;
}

export function phasesHtml(snap: Snapshot): string {
  const job = snap.job;
  if (!job) return '';
  const p = job.progress;
  const total = download(job.app, job.hd);
  const game = Math.max(0, Math.min(1, (p - 20) / 65));
  const defs = job.kind === 'update' ? [
    { label: t('phase.findVersion'), from: 0, to: 5, detail: '' },
    { label: t('phase.loadUpdate'), from: 5, to: 85, detail: t('phase.updateEta', { n: Math.max(1, Math.ceil((85 - p) / 12)) }) },
    { label: t('phase.applyVersion'), from: 85, to: 100, detail: '' }
  ] : [
    { label: t('phase.systemChecked'), from: 0, to: 5, detail: '' },
    { label: t('phase.environment'), from: 5, to: 20, detail: '' },
    { label: t('phase.game'), from: 20, to: 85, detail: t('phase.gameDetail', { done: formatNumber(total * game), total: formatNumber(total), n: Math.max(1, Math.ceil((1 - game) * 12)) }) },
    { label: t('phase.bluetooth'), from: 85, to: 95, detail: '' },
    { label: t('phase.finish'), from: 95, to: 100, detail: '' }
  ];
  return defs.map((d) => {
    const done = p >= d.to;
    const active = !done && p >= d.from;
    return `<div class="phase ${done ? 'done' : active ? 'active' : 'todo'}">
      <span class="mark">${done ? ICON.check : '<span class="ring"></span>'}</span>
      <span><span class="phasetitle">${d.label}</span>${active && d.detail ? `<br><span class="muted small">${d.detail}</span>` : ''}</span>
    </div>`;
  }).join('');
}

function progress(ui: Ui, snap: Snapshot): string {
  const job = snap.job;
  const p = job?.progress ?? 0;
  const app = job?.app ?? ui.setupApp;
  return `<div class="page">
    <div class="split">
      <div>
        <p class="pct" id="pct">${p} %</p>
        <div class="bar lg"><i id="bar" ${width(p)}></i></div>
        <h1 class="title h1-sm">${t(job?.kind === 'update' ? 'progress.updating' : 'progress.installing', { app: APP_NAMES[app] })}</h1>
      </div>
      <div>
        <div class="panel phases" id="phases">${phasesHtml(snap)}</div>
        <div class="actions"><button class="btn" data-act="go" data-arg="library">${t('common.overview')}</button></div>
      </div>
    </div>
  </div>`;
}

const done = (ui: Ui): string => `<div class="center">
    <span class="bigcheck">${ICON.check}</span>
    <h1>${t(ui.updateDone ? 'done.upToDate' : 'done.ready', { app: APP_NAMES[ui.setupApp] })}</h1>
    <button class="btn primary" data-act="launch" data-arg="${ui.setupApp}">${t('btn.ride')}${ICON.go}</button>
    <button class="btn" data-act="go" data-arg="library">${t('common.overview')}</button>
  </div>`;

export const launchText = (phase: LaunchPhase | undefined, app?: AppId): string => {
  // Zwift prüft keinen Bluetooth-Adapter und keine Updates: es bereitet den Container vor und startet ihn.
  if (app === 'zwift') return phase === 'starting' ? t('launch.zwiftStart') : t('launch.zwiftPrepare');
  return phase === 'bluetooth' ? t('launch.bluetooth') : phase === 'starting' ? t('launch.starting') : t('launch.updates');
};

const launching = (ui: Ui, snap: Snapshot): string => `<div class="center onscene">
    <p class="splashname">${APP_NAMES[ui.launchApp]}</p>
    <p class="lead" id="launchText" role="status">${launchText(snap.launch?.phase, ui.launchApp)}</p>
    <div class="bar splashbar"><i id="launchBar" ${width(snap.launch?.progress ?? 0)}></i></div>
    <button class="btn" data-act="stopLaunch">${t('common.cancel')}</button>
  </div>`;

const running = (ui: Ui): string => `<div class="center onscene">
    <p class="pill ok"><span class="dot"></span>${t('launch.running')}</p>
    <p class="splashname">${APP_NAMES[ui.launchApp]}</p>
    <button class="btn" data-act="stopLaunch">${t('launch.quit')}</button>
  </div>`;

const btError = (ui: Ui): string => `<div class="page slim vcenter">
    ${ICON.alert}
    <h1 class="title">${t('error.bt.title')}</h1>
    <ol class="steps"><li>${t('error.bt.step1')}</li><li>${t('error.bt.step2')}</li></ol>
    <div class="actions left">
      <button class="btn primary" data-act="launch" data-arg="${ui.launchApp}">${t('error.bt.again')}</button>
      <button class="btn" data-act="ignoreBt">${t('error.bt.anyway')}</button>
      <button class="btn" data-act="go" data-arg="help">${t('common.getHelp')}</button>
    </div>
  </div>`;

const crash = (ui: Ui): string => `<div class="page slim vcenter">
    ${ICON.alert}
    <h1 class="title">${t('error.crash.title', { app: APP_NAMES[ui.launchApp] })}</h1>
    <div class="actions left">
      <button class="btn primary" data-act="safeStart">${t('error.crash.safe')}</button>
      <button class="btn" data-act="go" data-arg="help">${t('common.getHelp')}</button>
    </div>
  </div>`;

const failed = (ui: Ui, snap: Snapshot): string => `<div class="page slim vcenter">
    ${ICON.alert}
    <h1 class="title">${t('error.launch.title', { app: APP_NAMES[ui.launchApp] })}</h1>
    <p class="lead">${problemText(snap.launch?.problem || 'error')}</p>
    <div class="actions left">
      <button class="btn primary" data-act="launch" data-arg="${ui.launchApp}">${t('btn.retry')}</button>
      <button class="btn" data-act="go" data-arg="help">${t('common.getHelp')}</button>
    </div>
  </div>`;

export function scanHtml(snap: Snapshot): string {
  const { running: scanning, found } = snap.scan;
  return `<div class="row"><h2>${t('bt.nearby')}</h2>${scanning ? `<span class="scanning" role="status"><span class="spin"></span>${t('bt.searching')}</span>` : ''}</div>
    ${found.map((s) => `<div class="found">${ICON.check}<span><strong>${esc(s.name)}</strong> <span class="muted">${t(s.kind === 'trainer' ? 'bt.trainer' : 'bt.heartrate')} · ${esc(s.id)}</span></span></div>`).join('')}
    ${!scanning && found.length ? `<p>${t('bt.allThere')}</p>` : ''}
    ${!scanning && !found.length ? `<p>${t('bt.nothing')}</p>` : ''}`;
}

function bluetooth(ui: Ui, snap: Snapshot): string {
  const problem = snap.bluetooth.state === 'problem';
  return `<div class="page">
    ${backBtn('appmenu')}
    <div class="split">
      <div>
        <h1 class="title">${t('bt.title')}</h1>
        <p class="pill ${problem ? 'warn' : 'ok'}"><span class="dot"></span>${problem ? t('bt.check') : t('bt.ready')}</p>
        <div class="radar"><i></i><i></i><i></i><b>${ICON.bt}</b></div>
      </div>
      <div>
        <div class="panel stack" id="scan">${scanHtml(snap)}</div>
        <div class="actions">
          <button class="btn" data-act="repair">${t('bt.repair')}</button>
          <button class="linkbtn" data-act="btHelp">${t('bt.noBt')}</button>
        </div>
        ${ui.btHelp ? `<div class="panel mt-16"><p>${t('bt.phone')}</p></div>` : ''}
      </div>
    </div>
  </div>`;
}

/** Menü einer App (Zahnrad auf der Karte): Steam, Bluetooth (nur MyWhoosh), erweiterte Einstellungen, Deinstallieren. */
function appMenu(ui: Ui, snap: Snapshot): string {
  const id = ui.menuApp;
  const info = snap.apps[id];
  const btProblem = snap.bluetooth.state === 'problem';
  const stopping = snap.launch?.app === id;
  return `<div class="page slim">
    ${backBtn('library')}
    <h1 class="${info.version ? '' : 'mb-32'}">${APP_NAMES[id]}</h1>
    ${info.version ? `<p class="muted mb-32">${esc(info.version)}</p>` : ''}
    <div class="panel stack">
      <div class="row"><span>${t('settings.steamRow', { app: APP_NAMES[id] })}</span>${sw(info.steam, 'steam', t('settings.steamRow', { app: APP_NAMES[id] }), id)}</div>
      ${id === 'mywhoosh' ? `<button class="btn row-btn" data-act="go" data-arg="bluetooth"><span class="rowtext"><span>${t('bt.title')}</span><span class="muted small">${btProblem ? t('home.btCheck') : t('home.btReady')} <span class="live ${btProblem ? 'warn' : ''}"></span></span></span>${ICON.next}</button>` : ''}
      ${id === 'zwift' ? zwiftNote(snap.zwiftRuntime) : ''}
      <button class="btn row-btn" data-act="appAdvanced" data-arg="${id}">${t('settings.advanced')}${ICON.next}</button>
      <hr class="divider">
      <div class="row">
        <span class="rowtext"><strong>${t('remove.button')}</strong><span class="muted small">${t('remove.uses', { gb: space(id, false) })}</span>${info.problem ? `<span class="warntext small" role="alert">${t('remove.failed')}</span>` : ''}</span>
        <button class="btn danger" data-act="remove" data-arg="${id}" ${stopping || !!snap.job ? 'disabled' : ''}>${t('remove.button')}</button>
      </div>
    </div>
  </div>`;
}

function rolloutSteamRow(snap: Snapshot): string {
  const s = snap.rolloutSteam;
  const note = s.busy ? t('settings.rolloutSteamBusy')
    : s.state === 'unavailable' ? t('settings.rolloutSteamUnavailable')
    : s.message ? t('settings.rolloutSteamError')
    : s.state === 'in' ? t('settings.rolloutSteamIn') : '';
  return `<div class="row">
      <span class="rowtext"><span>${t('settings.rolloutSteam')}</span>${note ? `<span class="muted small" role="status">${note}</span>` : ''}</span>
      ${sw(s.state === 'in', 'rolloutSteam', t('settings.rolloutSteam'), '', s.busy || s.state === 'unavailable')}
    </div>`;
}

/** Zeile „Rollout <Version>“ in den Einstellungen. Die Knopf-Kennung bleibt gleich, damit der Fokus beim Zustandswechsel auf der Zeile bleibt. */
export function selfUpdateNote(snap: Snapshot): string {
  const su = snap.selfUpdate;
  switch (su.status) {
    case 'checking': return `<span class="scanning"><span class="spin"></span>${t('su.checking')}</span>`;
    case 'checkFailed': return t('su.checkFailed');
    case 'available': return t('su.available', { version: su.next, mb: su.mb });
    case 'downloading': return t('su.downloading', { pct: su.progress });
    case 'ready': return su.blocked ? t('su.nextStart') : t('su.ready', { version: su.next });
    case 'invalid': return `<span class="warntext">${t('su.invalid')}</span>`;
    case 'noSpace': return `<span class="warntext">${t('su.noSpace')}</span>`;
    case 'manual': return `<span class="warntext">${t('su.manual')}</span>`;
    case 'current': return t('su.current');
    default: return '';
  }
}

function selfUpdateRow(snap: Snapshot): string {
  const su = snap.selfUpdate;
  const note = selfUpdateNote(snap);
  const button = (act: string, label: string, disabled = false): string =>
    `<button class="btn" id="su-btn" data-act="${act}" ${disabled ? 'disabled' : ''}>${label}</button>`;
  const action = su.status === 'none' || su.status === 'manual' ? ''
    : su.status === 'available' ? button('suDownload', t('su.download'), su.blocked)
    : su.status === 'downloading' ? button('suCancel', t('common.cancel'))
    : su.status === 'ready' ? button('suRestartNow', t('su.restart'), su.blocked)
    : button('suCheck', t('su.check'), su.status === 'checking');
  return `<div class="surow">
      <div class="row">
        <span class="rowtext"><span>Rollout ${esc(su.version)}</span>${note ? `<span class="muted small" id="su-note" role="status">${note}</span>` : ''}</span>
        ${action}
      </div>
      ${su.status === 'downloading' ? `<div class="bar"><i id="su-bar" ${width(su.progress)}></i></div>` : ''}
    </div>`;
}

function settings(snap: Snapshot): string {
  const steamRows = APP_IDS.filter((id) => snap.apps[id].installed).map((id) => `<div class="row">
      <span>${t('settings.steamRow', { app: APP_NAMES[id] })}</span>
      ${sw(snap.apps[id].steam, 'steam', t('settings.steamRow', { app: APP_NAMES[id] }), id)}
    </div>`).join('');
  return `<div class="page slim">
    ${backBtn('library')}
    <h1 class="mb-32">${t('settings.title')}</h1>
    <div class="panel stack">
      <div class="row"><label for="lang">${t('settings.language')}</label><select id="lang" data-change="language"><option value="auto" ${snap.language === 'auto' ? 'selected' : ''}>${t('lang.auto')}</option>${LANGUAGES.map((code) => `<option value="${code}" ${snap.language === code ? 'selected' : ''}>${esc(languageName(code))}</option>`).join('')}</select></div>
      <div class="row"><label for="scale">${t('settings.scale')}</label><select id="scale" data-change="scale">${['auto', '100', '125', '150', '175', '200'].map((v) => `<option value="${v}" ${snap.scale === v ? 'selected' : ''}>${v === 'auto' ? t('lang.auto') : `${v} %`}</option>`).join('')}</select></div>
      <div class="row"><label for="theme">${t('settings.theme')}</label><select id="theme" data-change="theme">${(['auto', 'dark', 'light'] as const).map((v) => `<option value="${v}" ${snap.theme === v ? 'selected' : ''}>${t(`theme.${v}` as const)}</option>`).join('')}</select></div>
      <div class="row"><span>${t('settings.auto')}</span>${sw(snap.autoUpdate, 'auto', t('settings.auto'))}</div>
      ${selfUpdateRow(snap)}
      ${rolloutSteamRow(snap)}
      ${steamRows}
      <hr class="divider">
      <button class="btn row-btn" data-act="go" data-arg="help">${t('common.getHelp')}${ICON.next}</button>
      <button class="btn row-btn" data-act="go" data-arg="remove">${t('settings.remove')}${ICON.next}</button>
    </div>
    <button class="advbtn" data-act="advanced"><span class="advtitle">${t('settings.advanced')}</span>${ICON.next}</button>
  </div>`;
}

const help = (ui: Ui): string => `<div class="page slim">
    ${backBtn('settings')}
    <h1 class="title">${t('help.title')}</h1>
    <p class="lead mb-32">${t('help.lead')}</p>
    <button class="btn primary start" data-act="report">${t('help.create')}</button>
    ${ui.reportDone ? `<div class="panel mt-24"><div class="ready">${ICON.check}<span>${t('help.done')}</span></div></div>` : ''}
  </div>`;

function remove(snap: Snapshot): string {
  const rows = APP_IDS.filter((id) => snap.apps[id].installed).map((id) => `<div class="row">
      <span class="rowtext"><strong>${APP_NAMES[id]}</strong><span class="muted small">${t('remove.uses', { gb: space(id, false) })}</span>${snap.apps[id].problem ? `<span class="warntext small" role="alert">${t('remove.failed')}</span>` : ''}</span>
      <button class="btn danger" data-act="remove" data-arg="${id}">${t('remove.button')}</button>
    </div>`).join('');
  return `<div class="page slim">
    ${backBtn('settings')}
    <h1 class="mb-32">${t('remove.title')}</h1>
    <div class="panel stack">${rows || `<p class="muted">${t('remove.none')}</p>`}</div>
  </div>`;
}

const gate = (): string => `<div class="center">
    <h1 class="maxw">${t('gate.title')}</h1>
    <button class="btn primary" data-act="go" data-arg="settings">${t('gate.back')}</button>
    <button class="btn ghost" data-act="passGate">${t('gate.open')}</button>
  </div>`;

function advancedAppPanel(tab: AppId, snap: Snapshot): string {
  const o = snap.overrides[tab];
  const note = o.mode === 'custom' ? versionNote(o.version) : null;
  const opt = (v: string): string => `<option value="${v}" ${o.version === v ? 'selected' : ''}>${v}</option>`;
  const gfx = (v: string, label: string): string => `<option value="${v}" ${o.graphics === v ? 'selected' : ''}>${label}</option>`;
  return `<div class="panel stack">
    <h2>${t('adv.proton')}</h2>
    <label class="radio"><input type="radio" name="proton" data-change="protonRec" ${o.mode === 'rec' ? 'checked' : ''}><span class="radiotext">${t('adv.protonRec')}</span><span class="mono">${RECOMMENDED_PROTON}</span></label>
    <label class="radio"><input type="radio" name="proton" data-change="protonCustom" ${o.mode === 'custom' ? 'checked' : ''}><span class="radiotext">${t('adv.protonCustom')}</span>
      <select id="protonVersion" aria-label="${t('adv.protonPick')}" data-change="version" ${o.mode === 'rec' ? 'disabled' : ''}>
        ${PROTON_VERSIONS.map(opt).join('')}
      </select></label>
    ${note ? `<p class="note warn">${note}</p>` : ''}
    <hr class="divider">
    <div class="row"><label class="rowtext" for="gfx"><span>${t('adv.graphics')}</span><span class="muted small">${t('adv.rec.auto')}</span></label>
      <select id="gfx" data-change="graphics">${gfx('auto', t('adv.graphics.auto'))}${gfx('wayland', t('adv.graphics.wayland'))}${gfx('x11', t('adv.graphics.x11'))}</select></div>
    <div class="row"><span class="rowtext"><span>${t('adv.extraVars')}</span><span class="muted small">${t('adv.rec.none')}</span></span><button class="btn">${t('adv.edit')}</button></div>
    <hr class="divider">
    <button class="btn row-btn">${t('adv.resetEnv')}${ICON.next}</button>
    <button class="btn row-btn">${t('adv.logs')}${ICON.next}</button>
  </div>`;
}

const advancedBtPanel = (): string => `<div class="panel stack">
    <div class="row"><label class="rowtext" for="ad"><span>${t('adv.adapter')}</span><span class="muted small">${t('adv.rec.auto')}</span></label><select id="ad"><option>${t('adv.adapter.auto')}</option><option>${t('adv.adapter.internal')}</option><option>${t('adv.adapter.usb')}</option></select></div>
    <div class="row"><span class="rowtext"><span>${t('adv.usbPower')}</span><span class="muted small">${t('adv.usbPowerNote')}</span></span>${sw(false, '', t('adv.usbPower'))}</div>
    <div class="row"><span class="rowtext"><span>${t('adv.preTest')}</span><span class="muted small">${t('adv.rec.on')}</span></span>${sw(true, '', t('adv.preTest'))}</div>
  </div>`;

const advancedLauncherPanel = (snap: Snapshot): string => `<div class="panel stack">
    <div class="row"><label class="rowtext" for="ch"><span>${t('adv.channel')}</span><span class="muted small">${t('adv.rec.stable')}</span></label><select id="ch" data-change="channel"><option value="stable" ${snap.updateChannel === 'stable' ? 'selected' : ''}>${t('adv.channel.stable')}</option><option value="beta" ${snap.updateChannel === 'beta' ? 'selected' : ''}>${t('adv.channel.beta')}</option></select></div>
    ${snap.selfUpdate.previous ? `<div class="row"><span class="rowtext"><span>${t('adv.previous')}</span><span class="muted small">${esc(snap.selfUpdate.previous)}</span></span><button class="btn" data-act="prevAsk" ${snap.selfUpdate.blocked ? 'disabled' : ''}>${t('adv.previousStart')}</button></div>` : ''}
    <div class="row"><span>${t('adv.projects')}</span><button class="btn">${t('adv.show')}</button></div>
    <div class="row"><label class="rowtext" for="lg"><span>${t('adv.verbose')}</span><span class="muted small">${t('adv.rec.normal')}</span></label><select id="lg"><option>${t('adv.verbose.normal')}</option><option>${t('adv.verbose.verbose')}</option></select></div>
  </div>`;

function advanced(ui: Ui, snap: Snapshot): string {
  const tabs: [AdvTab, string][] = [['mywhoosh', APP_NAMES.mywhoosh], ['zwift', APP_NAMES.zwift], ['bluetooth', t('adv.tab.bluetooth')], ['launcher', t('adv.tab.launcher')]];
  const tabButtons = tabs.map(([id, label]) =>
    `<button class="tab ${ui.advTab === id ? 'on' : ''}" aria-pressed="${ui.advTab === id}" data-act="tab" data-arg="${id}">${label}</button>`).join('');
  const panel = ui.advTab === 'bluetooth' ? advancedBtPanel() : ui.advTab === 'launcher' ? advancedLauncherPanel(snap) : advancedAppPanel(ui.advTab, snap);
  return `<div class="page mid">
    <div class="row mb-20 wrap">
      <button class="btn ghost pull" data-act="go" data-arg="settings">${ICON.back}${t('common.back')}</button>
      <button class="btn" data-act="resetAll" ${anyCustom(snap) ? '' : 'disabled'}>${t('adv.reset')}</button>
    </div>
    <h1 class="mb-28">${t('adv.title')}</h1>
    <div class="tabs" role="group" aria-label="${t('adv.section')}">${tabButtons}</div>
    ${panel}
  </div>`;
}

export function view(ui: Ui, snap: Snapshot): string {
  switch (ui.screen) {
    case 'library': return library(snap);
    case 'setup': return setup(ui, snap);
    case 'progress': return progress(ui, snap);
    case 'done': return done(ui);
    case 'launching': return launching(ui, snap);
    case 'running': return running(ui);
    case 'bterror': return btError(ui);
    case 'crash': return crash(ui);
    case 'failed': return failed(ui, snap);
    case 'bluetooth': return bluetooth(ui, snap);
    case 'appmenu': return appMenu(ui, snap);
    case 'settings': return settings(snap);
    case 'help': return help(ui);
    case 'remove': return remove(snap);
    case 'gate': return gate();
    case 'advanced': return advanced(ui, snap);
  }
}

export function modal(ui: Ui, snap: Snapshot): string {
  if (ui.confirmQuit) {
    return `<div class="modalbg"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="dlg">
      <h2 id="dlg">${t('quit.title')}</h2>
      <p class="muted">${t('quit.body')}</p>
      <div class="actions"><button class="btn danger" data-act="quitConfirm">${t('quit.confirm')}</button><button class="btn primary" data-act="closeModal">${t('common.cancel')}</button></div>
    </div></div>`;
  }
  if (ui.confirmRestart) {
    return `<div class="modalbg"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="dlg">
      <h2 id="dlg">${t('su.dlgTitle')}</h2>
      <p class="muted">${t('su.dlgBody', { version: snap.selfUpdate.next })}</p>
      <div class="actions"><button class="btn ghost" data-act="closeModal">${t('su.later')}</button><button class="btn primary" data-act="suRestartNow">${t('su.restart')}</button></div>
    </div></div>`;
  }
  if (ui.confirmPrevious) {
    return `<div class="modalbg"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="dlg">
      <h2 id="dlg">${t('adv.previousTitle', { version: snap.selfUpdate.previous })}</h2>
      <p class="muted">${t('adv.previousBody', { current: snap.selfUpdate.version })}</p>
      <div class="actions"><button class="btn" data-act="prevNow">${t('adv.previousStart')}</button><button class="btn primary" data-act="closeModal">${t('common.cancel')}</button></div>
    </div></div>`;
  }
  if (ui.picker) {
    const items = ui.picker.options.map((o, i) =>
      `<button class="btn row-btn" data-act="pick" data-arg="${i}" ${o.selected ? 'data-initial aria-current="true"' : ''}><span>${esc(o.label)}</span>${o.selected ? ICON.check : ''}</button>`).join('');
    return `<div class="modalbg"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="dlg">
      <h2 id="dlg">${esc(ui.picker.title)}</h2>
      <div class="stack picker">${items}</div>
    </div></div>`;
  }
  if (ui.steamModal || ui.steamRollout !== null) {
    return `<div class="modalbg"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="dlg">
      <h2 id="dlg">${t('steam.title')}</h2>
      ${ui.steamRollout !== null ? `<p class="muted">${t('steam.restartBody')}</p>` : ''}
      <div class="actions"><button class="btn ghost" data-act="closeModal">${t('steam.later')}</button><button class="btn primary" data-act="${ui.steamRollout !== null ? 'steamRestartNow' : 'closeModal'}">${t('steam.now')}</button></div>
    </div></div>`;
  }
  if (ui.confirmImage) {
    return `<div class="modalbg"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="dlg">
      <h2 id="dlg">${t('image.title')}</h2>
      <p class="muted">${t('image.body', { tag: snap.zwiftTag, gb: download('zwift', false) })}</p>
      <div class="actions"><button class="btn primary" data-act="imageConfirm">${t('image.confirm')}</button><button class="btn ghost" data-act="closeModal">${t('common.cancel')}</button></div>
    </div></div>`;
  }
  if (ui.confirmRemove) {
    const id = ui.confirmRemove;
    return `<div class="modalbg"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="dlg">
      <h2 id="dlg">${t('remove.confirmTitle', { app: APP_NAMES[id] })}</h2>
      <p class="muted">${id === 'zwift' && snap.zwiftTag ? t('remove.confirmBodyImage', { tag: snap.zwiftTag, gb: space(id, false) }) : t('remove.confirmBody', { gb: space(id, false) })}</p>
      <div class="actions"><button class="btn danger" data-act="removeConfirm" data-arg="${id}">${t('remove.button')}</button><button class="btn primary" data-act="closeModal">${t('common.cancel')}</button></div>
    </div></div>`;
  }
  if (noticeVisible(ui, snap)) {
    return `<div class="modalbg"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="dlg">
      <h2 id="dlg">${t('su.undoneTitle')}</h2>
      <p class="muted">${t('su.undoneBody', { version: snap.selfUpdate.notice })}</p>
      <div class="actions"><button class="btn primary" data-act="suNoticeOk">${t('common.ok')}</button></div>
    </div></div>`;
  }
  return '';
}

/** Hinweis nach einem Rollback: einmalig auf der Startseite, bis er bestätigt wurde. */
export const noticeVisible = (ui: Ui, snap: Snapshot): boolean =>
  ui.screen === 'library' && !!snap.selfUpdate.notice && !ui.steamModal && ui.steamRollout === null && !ui.picker && !ui.confirmRemove && !ui.confirmQuit
  && !ui.confirmRestart && !ui.confirmPrevious && !ui.confirmImage;
