// Klicktest: startet die App mit simuliertem Zustand, geht alle Ansichten durch und prüft Kerntexte.
// Aufruf: ELECTRON_BIN=<electron> ELECTRON_RUN_AS_NODE=1 <electron> test/smoke.mjs   (Electron bringt Node mit WebSocket mit)
// Optional: ROLLOUT_SHOTS=<Ordner> legt je Ansicht einen Screenshot ab, ROLLOUT_ONLY=<Name> startet nur passende Szenarien.
// Rahmen, Attrappen und Wegwerf-Ordner stehen in test/harness.mjs.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { failuresExit, session, sleep, testKey } from './harness.mjs';
import { bumpVersion, electronVersionOf, packElectron } from '../scripts/release.mjs';
import { installBase, keepRuntime, linkOf, ownVersion, publish, stageUpdate, stateFile, withHome } from './update-probe.mjs';

await session('frisch', { ROLLOUT_SIM_STATE: 'fresh' }, async (t) => {
  await t.expect(t.has('Not installed · downloads 4 GB'), 'MyWhoosh nicht installiert');
  await t.shot('1-start');
  await t.click('Install');
  await t.expect(t.waitFor('Install MyWhoosh'), 'Installieren-Ansicht');
  await t.shot('2-installieren');
  await t.click('Back');
  await t.expect(t.waitFor('Settings'), 'zurück zur Übersicht');
  await t.expect(t.clickSel('article[data-tone=zwift] .btn.primary'), 'Zwift-Karte angeklickt');
  await t.expect(t.waitFor('Not officially supported by Zwift'), 'Zwift-Hinweis');
  await t.shot('3-zwift');
  await t.click('Install');
  await t.expect(t.waitFor('is being installed'), 'Fortschritt-Ansicht');
  await sleep(2500);
  await t.shot('4-fortschritt');
  await t.expect(t.waitFor('is ready', 25000), 'Installation fertig');
  await t.shot('5-fertig');
  await t.click('Ride');
  await t.expect(t.waitFor('Running', 15000), 'Spiel läuft');
  await t.shot('6-laeuft');
  await t.click('Quit game');
  await t.expect(t.waitFor('Settings'), 'zurück in der Übersicht');
});

// Zwift über die Attrappe des Adapters (ROLLOUT_ZWIFT=fake): Skript und Image kommen aus dem Dienst, nicht aus der Simulation.
// Vor dem Herunterladen fragt ein Dialog mit Tag und Größe; Starten läuft über den Dienst (Phasen aus der Ausgabe).
await session('zwift-attrappe', { ROLLOUT_SIM_STATE: 'fresh', ROLLOUT_ZWIFT: 'fake', ROLLOUT_ZWIFT_RUNNING_MS: '1500' }, async (t) => {
  await t.expect(t.clickSel('article[data-tone=zwift] .btn.primary'), 'Zwift-Karte angeklickt');
  await t.expect(t.waitFor('Not officially supported by Zwift'), 'Zwift-Hinweis');
  await t.click('Install');
  await t.expect(t.waitFor('Download the Zwift image?'), 'Zustimmungsdialog');
  await t.expect(t.has('version 1.0.0, about 6 GB'), 'Dialog nennt Tag und Größe');
  await t.expect((async () => (await t.focus()) === 'Download')(), 'Fokus auf „Download“');
  await t.shot('1-zustimmung');
  await t.click('Cancel');
  await t.expect((async () => !(await t.has('Download the Zwift image?')))(), 'Dialog geschlossen, nichts geladen');
  await t.expect(t.has('Install Zwift'), 'noch in der Installieren-Ansicht');
  await t.click('Install');
  await t.click('Download');
  await t.expect(t.waitFor('is being installed'), 'Fortschritt-Ansicht');
  await t.expect(t.waitFor('is ready', 25000), 'Installation über den Dienst fertig');
  await t.click('Ride');
  await t.expect(t.waitFor('Starting Zwift', 15000), 'Phase „Zwift startet“ aus der Ausgabe');
  await t.shot('2-startet');
  await t.expect(t.waitFor('Running', 15000), 'Spiel läuft');
  await t.expect((async () => !(await t.has('Bluetooth')))(), 'Zwift prüft kein Bluetooth');
  await t.click('Quit game');
  await t.expect(t.waitFor('Settings'), 'zurück in der Übersicht');
  await t.expect(t.waitFor('Closing …', 3000), 'Karte zeigt „Closing …“, solange Zwift beendet wird');
  await t.expect((async () => !(await t.eval(`document.querySelector('article[data-tone=zwift] .btn.primary').disabled === false`)))(), 'Knopf „Ride“ in dieser Zeit gesperrt');
  await t.expect(t.waitUntil(async () => (await t.snapshot()).launch === null), 'Start beendet');
  await t.expect(t.waitFor('Ready'), 'Karte wieder „Ready“');
});

// Probleme beim Installieren: Grund als Satz in der Installieren-Ansicht, Pille an der Karte, neuer Versuch möglich.
for (const [mode, text] of [['nonet', 'could not download the Zwift start script'], ['nopull', 'image could not be downloaded'], ['norun', 'Podman or Docker is not working']]) {
  await session(`zwift-problem-${mode}`, { ROLLOUT_SIM_STATE: 'fresh', ROLLOUT_ZWIFT: 'fake', ROLLOUT_SIM_ZWIFT: mode }, async (t) => {
    if (mode === 'norun') {
      await t.expect(t.waitUntil(async () => (await t.has('Needs attention'))), 'Pille „Needs attention“ an der Karte, schon vor einem Versuch');
    } else {
      await t.expect(t.clickSel('article[data-tone=zwift] .btn.primary'), 'Zwift-Karte angeklickt');
      await t.click('Install');
      await t.click('Download');
      await t.expect(t.waitFor(text, 25000), `Grund steht in der Installieren-Ansicht (${mode})`);
    }
    if (mode === 'norun') await t.clickSel('article[data-tone=zwift] .btn.primary');
    await t.expect(t.waitFor(text, 10000), `Grund: ${text}`);
    await t.expect(t.has('Try again'), 'Knopf „Try again“');
    await t.shot('1-problem');
    await t.click('Back');
    await t.expect(t.waitFor('Needs attention'), 'Pille an der Karte');
    await t.expect((async () => (await t.snapshot()).apps.mywhoosh.problem === '')(), 'MyWhoosh unberührt');
  });
}

// Probleme beim Start: Absturz (Exit 1 kurz nach dem Start) und „Image fehlt“ (Exit 12) mit Grund und neuem Versuch.
await session('zwift-start-absturz', { ROLLOUT_SIM_STATE: 'fresh', ROLLOUT_ZWIFT: 'fake', ROLLOUT_SIM_ZWIFT: 'runcrash' }, async (t) => {
  await t.click('Ride');
  await t.expect(t.waitFor('closed right after starting', 15000), 'Absturz-Ansicht');
});
await session('zwift-start-fehler', { ROLLOUT_SIM_STATE: 'fresh', ROLLOUT_ZWIFT: 'fake', ROLLOUT_SIM_ZWIFT: 'runfail', ROLLOUT_SIM_LANG: 'de' }, async (t) => {
  await t.click('Losfahren');
  await t.expect(t.waitFor('ließ sich nicht starten', 15000), 'Start gescheitert (Deutsch)');
  await t.expect(t.has('Zwift-Image konnte nicht geladen werden'), 'Grund auf Deutsch');
  await t.shot('1-start-fehler');
  await t.click('Nochmal versuchen');
  await t.expect(t.waitFor('ließ sich nicht starten', 15000), 'neuer Versuch möglich');
  await t.click('Zurück');
});

// Entfernen: Rückfrage nennt Tag und Größe, danach ist das Image weg; scheitert es, bleibt Zwift und die Zeile nennt den Grund.
await session('zwift-entfernen', { ROLLOUT_SIM_STATE: 'fresh', ROLLOUT_ZWIFT: 'fake', ROLLOUT_SIM_ZWIFT: 'ready' }, async (t) => {
  await t.click('Settings');
  await t.click('Remove an app');
  await t.expect(t.clickSel('button[data-act=remove][data-arg=zwift]'), 'Entfernen für Zwift');
  await t.expect(t.waitFor('Remove Zwift?'), 'Rückfrage');
  await t.expect(t.has('version 1.0.0') , 'Rückfrage nennt den Tag');
  await t.shot('1-entfernen');
  await t.clickSel('button[data-act=removeConfirm]');
  await t.expect(t.waitFor('No app is installed.', 10000), 'Zwift entfernt');
});
await session('zwift-entfernen-fehler', { ROLLOUT_SIM_STATE: 'fresh', ROLLOUT_ZWIFT: 'fake', ROLLOUT_SIM_ZWIFT: 'norem' }, async (t) => {
  await t.click('Settings');
  await t.click('Remove an app');
  await t.clickSel('button[data-act=remove][data-arg=zwift]');
  await t.clickSel('button[data-act=removeConfirm]');
  await t.expect(t.waitFor('The image could not be removed', 10000), 'Grund in der Zeile');
  await t.expect(t.has('Zwift'), 'Zwift bleibt in der Liste');
});

// Echtes Zwift mit Container-Attrappen im PATH und ersetztem Upstream (nie ein echter Container; das echte zwift.sh wird geladen, geprüft
// und mit DRYRUN getrennt probiert). Braucht Netz für das Skript von GitHub, deshalb nur mit ROLLOUT_ZWIFT_NET=1.
if (process.env.ROLLOUT_ZWIFT_NET === '1') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-zwift-real-'));
  const fakebin = path.join(home, 'fakebin');
  fs.mkdirSync(path.join(home, 'bin'));
  fs.mkdirSync(fakebin);
  fs.copyFileSync(new URL('../scripts/bin-rollout-run.sh', import.meta.url).pathname, path.join(home, 'bin/rollout-run'));
  fs.chmodSync(path.join(home, 'bin/rollout-run'), 0o755);
  const tool = `#!/bin/sh
# rollout-test-attrappe
echo "\${0##*/} $*" >> "$ROLLOUT_HOME/containers.log"
case $1 in
  info) exit 0 ;;
  image) [ -f "$ROLLOUT_HOME/image-present" ] || exit 1; exit 0 ;;
  pull) echo "Copying blob aaa done"; sleep 0.3; echo "Copying blob bbb done"; : > "$ROLLOUT_HOME/image-present"; exit 0 ;;
  rmi) rm -f "$ROLLOUT_HOME/image-present"; exit 0 ;;
esac
exit 0
`;
  for (const name of ['podman', 'docker']) fs.writeFileSync(path.join(fakebin, name), tool, { mode: 0o755 });
  fs.writeFileSync(path.join(home, 'up.sh'), '#!/bin/sh\necho "[*] Preparing to launch Zwift"\nsleep 0.5\necho "[*] Launching Zwift"\nsleep 30 &\ns=$!\ntrap \'kill $s; exit 143\' TERM\nwait $s\n', { mode: 0o755 });
  const log = () => { try { return fs.readFileSync(path.join(home, 'containers.log'), 'utf8'); } catch { return ''; } };
  await session('zwift-echt', {
    ROLLOUT_SIM_STATE: 'fresh', ROLLOUT_ZWIFT: 'real', ROLLOUT_ZWIFT_RUNNING_MS: '1500',
    PATH: `${fakebin}:${process.env.PATH}`, ROLLOUT_RUN_UPSTREAM: path.join(home, 'up.sh'), ROLLOUT_RUN_NO_INHIBIT: '1'
  }, async (t) => {
    await t.expect(t.waitUntil(async () => (await t.snapshot()).zwiftTag !== ''), 'echter Dienst aktiv (Tag im Zustand)');
    await t.expect(t.clickSel('article[data-tone=zwift] .btn.primary'), 'Zwift-Karte angeklickt');
    await t.click('Install');
    await t.expect(t.waitFor('Download the Zwift image?'), 'Zustimmungsdialog');
    await t.shot('1-zustimmung');
    await t.click('Download');
    await t.expect(t.waitFor('is ready', 60000), 'Skript geladen, Prüfsumme stimmt, Image „gezogen“ (Attrappe)');
    await t.expect(log().includes('pull docker.io/netbrain/zwift:'), 'Ziehen nur nach Zustimmung, über die Attrappe');
    await t.click('Ride');
    await t.expect(t.waitFor('Starting Zwift', 15000), 'Phase aus der Ausgabe des Starters');
    await t.expect(t.waitFor('Running', 15000), 'läuft');
    await t.shot('2-laeuft');
    await t.expect((async () => fs.existsSync(path.join(home, 'state/run.pid')))(), 'run.pid vom Starter');
    await t.click('Quit game');
    await t.expect(t.waitUntil(async () => (await t.snapshot()).launch === null && !fs.existsSync(path.join(home, 'state/run.pid')), 15000), 'Spiel beendet, run.pid weg');
    await t.click('Settings');
    await t.click('Remove an app');
    await t.clickSel('button[data-act=remove][data-arg=zwift]');
    await t.expect(t.waitFor('Remove Zwift?'), 'Rückfrage');
    await t.clickSel('button[data-act=removeConfirm]');
    await t.expect(t.waitFor('No app is installed.', 15000), 'entfernt');
    await t.expect(log().includes('rmi docker.io/netbrain/zwift:'), 'podman rmi lief (Attrappe)');
    await t.expect(!/ run /.test(log()), 'kein Container gestartet');
    await t.expect(!fs.existsSync(path.join(home, 'state/zwift-image-ok')), 'Zustimmung vergessen');
  }, { home });
  fs.rmSync(home, { recursive: true, force: true });
}

await session('einstellungen', {}, async (t) => {
  await t.click('Settings');
  await t.expect(t.waitFor('Download updates automatically'), 'Settings');
  await t.shot('1-einstellungen');
  await t.click('MyWhoosh in Steam');
  await t.expect(t.waitFor('Steam needs to restart briefly'), 'Steam-Dialog');
  await t.expect((async () => (await t.focus()) === 'Restart now')(), 'Fokus im Dialog auf dem Hauptknopf');
  await t.shot('2-dialog');
  await t.click('Do it later');
  await t.expect((async () => !(await t.has('Steam needs to restart briefly')))(), 'Dialog geschlossen');
  await t.click('Get help');
  await t.click('Create file');
  await t.expect(t.waitFor('Downloads'), 'Hilfe-Datei');
  await t.shot('3-hilfe');
  await t.click('Back');
  await t.click('Remove an app');
  await t.click('Remove');
  await t.expect(t.waitFor('Remove MyWhoosh?'), 'Rückfrage vor dem Entfernen');
  await t.shot('4-entfernen-dialog');
  await t.click('Cancel');
  await t.expect(t.has('Uses 8 GB'), 'App nach Abbruch noch da');
  await t.click('Back');
  await t.click('Advanced');
  await t.expect(t.waitFor('Here you can change things'), 'Abfrage vor Erweitert');
  await t.shot('5-abfrage');
  await t.click('Open anyway');
  await t.expect(t.waitFor('Proton version'), 'Advanced');
  await t.shot('6-erweitert');
  await t.click('Bluetooth');
  await t.expect(t.waitFor('Bluetooth adapter'), 'Reiter Bluetooth');
  await t.click('Launcher');
  await t.expect(t.waitFor('Update channel'), 'Reiter Launcher');
});

await session('bluetooth', { ROLLOUT_SIM_BT: 'problem' }, async (t) => {
  await t.expect(t.has('Check Bluetooth'), 'Bluetooth-Problem auf der Startseite');
  await t.click('Check Bluetooth');
  await t.expect(t.waitFor('Nothing found yet', 15000), 'Suche ohne Fund');
  await t.shot('1-bluetooth-problem');
  await t.click('Back');
  await t.click('Ride');
  await t.expect(t.waitFor('Your trainer was not found', 15000), 'Fehleransicht Trainer');
  await t.shot('2-fehler');
  await t.click('Start anyway');
  await t.expect(t.waitFor('Running', 15000), 'trotzdem gestartet');
});

await session('bluetooth-ok', {}, async (t) => {
  await t.click('Bluetooth ready');
  await t.expect(t.waitFor('All there.', 15000), 'Trainer und Gurt gefunden');
  await t.shot('1-bluetooth');
});

await session('update-absturz', { ROLLOUT_SIM_UPDATE: '1', ROLLOUT_SIM_CRASH: '1' }, async (t) => {
  await t.expect(t.has('Update available'), 'Update angezeigt');
  await t.click('Update');
  await t.expect(t.waitFor('is being updated'), 'Update läuft');
  await t.shot('1-update');
  await t.expect(t.waitFor('is up to date', 25000), 'Update fertig');
  await t.click('Ride');
  await t.expect(t.waitFor('closed right after starting', 15000), 'Absturz-Ansicht');
  await t.shot('2-absturz');
});

await session('deutsch', { ROLLOUT_SIM_LANG: 'de' }, async (t) => {
  await t.expect(t.has('Bereit'), 'Startseite auf Deutsch');
  await t.click('Einstellungen');
  await t.expect(t.waitFor('Updates automatisch laden'), 'Einstellungen auf Deutsch');
  await t.shot('1-einstellungen-de');
});

await session('steam-aus', {}, async (t) => {
  await t.click('Settings');
  await t.expect(t.waitFor('Rollout in Steam'), 'Zeile „Rollout in Steam“');
  if (process.env.ROLLOUT_DEBUG) console.log('vorher', await t.eval('window.rollout.getSnapshot().then((s) => JSON.stringify(s.rolloutSteam))'));
  await t.click('Rollout in Steam');
  await sleep(1500);
  if (process.env.ROLLOUT_DEBUG) console.log('nachher', await t.eval('window.rollout.getSnapshot().then((s) => JSON.stringify(s.rolloutSteam))'), await t.eval('document.querySelectorAll(".modalbg").length'));
  await t.expect(t.waitFor('Rollout appears in your Steam library.'), 'Eintrag ohne Neustart angelegt (Steam beendet)');
  await t.shot('1-steam-eintrag');
  await t.click('Rollout in Steam');
  await t.expect((async () => { await sleep(600); return !(await t.has('Rollout appears in your Steam library.')); })(), 'Eintrag wieder entfernt');
});

await session('steam-laeuft', { ROLLOUT_SIM_STEAM_RUNNING: '1' }, async (t) => {
  await t.click('Settings');
  await t.click('Rollout in Steam');
  await t.expect(t.waitFor('Steam closes and opens again'), 'Dialog mit Erklärung, weil Steam läuft');
  await t.expect((async () => (await t.focus()) === 'Restart now')(), 'Fokus auf „Restart now“');
  await t.shot('1-steam-dialog');
  await t.click('Restart now');
  await t.expect(t.waitFor('Rollout appears in your Steam library.'), 'Eintrag nach Neustart angelegt');
});

// ---------- Launcher-Update: Oberfläche (S1 bis S4) ----------
const noHint = (t) => t.eval('!document.querySelector(".su-hint")');
const suBtn = (t) => t.eval('(() => { const b = document.getElementById("su-btn"); return b ? { text: b.textContent.trim(), disabled: b.disabled } : null; })()');
const suNote = (t) => t.eval('document.getElementById("su-note")?.innerText ?? ""');

const SU_STATES = [
  ['none', '', async (t) => {
    await t.expect((async () => (await suBtn(t)) === null && (await suNote(t)) === '')(), 'Ohne Wächter: keine Zusatzzeile, kein Knopf');
  }],
  ['current', '', async (t) => {
    await t.expect((async () => (await suNote(t)) === 'Up to date' && (await suBtn(t))?.text === 'Check')(), 'Aktuell: „Up to date“, Knopf „Check“');
  }],
  ['checking', '', async (t) => {
    await t.expect((async () => (await suNote(t)) === 'Checking' && (await suBtn(t))?.disabled === true)(), 'Prüft: „Checking“, Knopf gesperrt');
    await t.expect(t.eval('!!document.querySelector("#su-note .spin")'), 'Prüft: Drehkreis');
  }],
  ['checkFailed', '', async (t) => {
    await t.expect((async () => (await suNote(t)).includes("Couldn't check right now") && (await suBtn(t))?.text === 'Check')(), 'Prüfung fehlgeschlagen');
  }],
  ['available', '', async (t) => {
    await t.expect((async () => (await suNote(t)) === 'Version 1.3.0 · 5 MB' && (await suBtn(t))?.text === 'Download')(), 'Update da: Version und Größe, Knopf „Download“');
  }],
  ['available,mb=129', '', async (t) => {
    await t.expect((async () => (await suNote(t)) === 'Version 1.3.0 · 129 MB')(), 'Update mit neuem Electron: 129 MB');
  }],
  ['downloading', '', async (t) => {
    await t.expect((async () => (await suNote(t)).includes('Downloading · 42 %') && (await suBtn(t))?.text === 'Cancel')(), 'Lädt: „Downloading · 42 %“, Knopf „Cancel“');
    await t.expect(t.eval('(() => { const i = document.getElementById("su-bar"); return !!i && i.style.width === "42%"; })()'), 'Lädt: Balken auf 42 %');
  }],
  ['ready', '', async (t) => {
    await t.expect((async () => (await suNote(t)) === 'Version 1.3.0 is ready' && (await suBtn(t))?.text === 'Restart now' && !(await suBtn(t)).disabled)(), 'Bereit: Text und Knopf „Restart now“');
  }],
  ['ready,blocked', '', async (t) => {
    await t.expect((async () => (await suNote(t)) === 'Applied the next time Rollout starts' && (await suBtn(t))?.disabled === true)(), 'Bereit, belegt: „Applied the next time…“, Knopf gesperrt');
  }],
  ['invalid', '', async (t) => {
    await t.expect((async () => (await suNote(t)) === 'Update failed its check' && (await suBtn(t))?.text === 'Check')(), 'Prüfung nicht bestanden');
    await t.expect(t.eval('getComputedStyle(document.querySelector("#su-note .warntext")).color !== getComputedStyle(document.getElementById("su-note")).color'), 'Hinweis in der Warnfarbe');
  }],
  ['noSpace', '', async (t) => {
    await t.expect((async () => (await suNote(t)) === 'Not enough storage for the update' && (await suBtn(t))?.text === 'Check')(), 'Zu wenig Platz');
  }],
  ['manual', '', async (t) => {
    await t.expect((async () => (await suNote(t)) === 'This update needs a fresh install' && (await suBtn(t)) === null)(), 'Format zu neu: Text, kein Knopf');
  }]
];

for (const [state, , check] of SU_STATES) {
  await session(`su-${state.replace(/[^a-z0-9]/gi, '-')}`, { ROLLOUT_SIM_SELFUPDATE: state }, async (t) => {
    await t.expect(state === 'ready' ? t.eval('!!document.querySelector(".su-hint")') : noHint(t), state === 'ready' ? 'Startseite mit Update-Knopf' : 'Startseite ohne Update-Knopf');
    await t.expect(t.eval('document.querySelectorAll("#view .cards .btn.primary").length === 2'), 'Startseite: ein Hauptknopf je Karte');
    await t.click('Settings');
    await t.expect(t.waitFor('Download updates automatically'), 'Einstellungen');
    await t.expect(t.has(`Rollout ${ownVersion()}`), 'Zeile „Rollout <Version>“');
    await check(t);
    await t.expect(t.eval('document.documentElement.scrollWidth <= window.innerWidth'), 'kein waagerechtes Scrollen');
    await t.shot('einstellungen');
  });
}

// Knopf in der Kopfzeile: sichtbar bei „bereit“ (nicht belegt) und bei „Update da“ mit auto_update aus.
await session('su-knopf-bereit', { ROLLOUT_SIM_SELFUPDATE: 'ready' }, async (t) => {
  await t.expect(t.eval('!!document.querySelector(".su-hint")'), 'Bereit: Knopf „Update Rollout“ in der Kopfzeile');
  await t.expect(t.eval('document.querySelector(".su-hint").getAttribute("aria-label") === "Update Rollout" && document.querySelector(".su-hint").title === "Update Rollout"'), 'Knopf hat aria-label und title');
  await t.expect(t.eval('(() => { const b = document.querySelector(".su-hint"); return b.nextElementSibling.textContent.includes("Bluetooth"); })()'), 'Knopf steht links neben „Bluetooth“');
  await t.expect(t.eval('!!document.querySelector(".su-hint .hintdot") && !document.querySelector(".su-hint .live")'), 'Punkt ohne Puls');
  await t.shot('1-start');
  // Echte Klicks fokussieren den Knopf, der Debug-Klick nicht: hier vorher fokussieren, damit der Rückweg des Fokus prüfbar ist.
  const openHint = () => t.eval('(() => { const b = document.querySelector(".su-hint"); b.focus(); b.click(); return true; })()');
  await openHint();
  await t.expect(t.waitFor('Restart Rollout?'), 'Klick: Dialog „Restart Rollout?“');
  await t.expect(t.has('Version 1.3.0 is ready. Restarting takes only a few seconds.'), 'Dialogtext');
  await t.expect((async () => (await t.focus()) === 'Restart now')(), 'Fokus auf „Restart now“ (Hauptknopf)');
  await t.shot('2-dialog');
  await t.click('Later');
  await t.expect((async () => { await sleep(400); return !(await t.has('Restart Rollout?')); })(), '„Later“ schließt den Dialog');
  await t.expect(t.eval('!!document.querySelector(".su-hint")'), 'Knopf bleibt nach „Later“');
  await openHint();
  await t.waitFor('Restart Rollout?');
  await t.eval('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true');
  await t.expect((async () => { await sleep(400); return !(await t.has('Restart Rollout?')); })(), 'Esc schließt den Dialog');
  await t.expect((async () => (await t.focus()) === 'Update Rollout')(), 'Fokus zurück auf dem Auslöser');
  await t.click('Update Rollout');
  await t.waitFor('Restart Rollout?');
  await t.click('Restart now');
  await t.expect(t.waitUntil(async () => (await t.snapshot()).selfUpdate.version === '1.3.0'), 'Neustart-Befehl kommt im Hauptprozess an (Attrappe)');
});

await session('su-knopf-auto-aus', { ROLLOUT_SIM_SELFUPDATE: 'available' }, async (t) => {
  await t.expect(t.eval('!!document.querySelector(".su-hint")'), 'Update da und auto_update aus: Knopf sichtbar');
  await t.click('Update Rollout');
  await t.expect(t.waitFor('Download updates automatically'), 'Klick öffnet die Einstellungen');
}, { config: 'auto_update = false\n' });

await session('su-knopf-auto-an', { ROLLOUT_SIM_SELFUPDATE: 'available' }, async (t) => {
  await t.expect(noHint(t), 'Update da, auto_update an: kein Knopf');
});

// S2: belegt
await session('s2-belegt', { ROLLOUT_SIM_SELFUPDATE: 'ready,blocked' }, async (t) => {
  await t.expect(noHint(t), 'S2 Belegt: Hinweis in der Kopfzeile weg');
  await t.click('Settings');
  await t.expect(t.waitFor('Applied the next time Rollout starts'), 'S2 Einstellungen: „Gilt beim nächsten Start“');
  await t.expect((async () => (await suBtn(t))?.disabled === true)(), 'S2 Neustart gesperrt');
  await t.expect(t.eval('!document.querySelector(".modalbg")'), 'S2 kein Dialog');
});

// S3: Rollback-Hinweis einmalig
await session('s3-rollback-hinweis', { ROLLOUT_SIM_SELFUPDATE: 'current,notice=1.3.0' }, async (t) => {
  await t.expect(t.waitFor('Update undone'), 'S3 Hinweis erscheint auf der Startseite');
  await t.expect(t.has("Version 1.3.0 wouldn't start. Rollout keeps using the previous version."), 'S3 Text mit Version');
  await t.expect((async () => (await t.focus()) === 'OK')(), 'S3 Fokus auf „OK“ (einziger Hauptknopf)');
  await t.expect(t.eval('document.querySelectorAll(".modal .btn").length === 1'), 'S3 nur ein Knopf');
  await t.shot('1-hinweis');
  await t.click('OK');
  await t.expect((async () => { await sleep(500); return !(await t.has('Update undone')); })(), 'S3 nach „OK“ weg');
  await t.click('Settings');
  await t.click('Back');
  await t.expect((async () => { await sleep(400); return !(await t.has('Update undone')); })(), 'S3 erscheint nicht erneut');
});

await session('s3-rollback-hinweis-esc', { ROLLOUT_SIM_SELFUPDATE: 'current,notice=1.3.0' }, async (t) => {
  await t.waitFor('Update undone');
  await t.eval('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true');
  await t.expect((async () => { await sleep(500); return !(await t.has('Update undone')); })(), 'S3 Esc bestätigt den Hinweis');
});

// Erweitert, Reiter „Launcher“: Kanal und vorherige Version
await session('su-launcher', { ROLLOUT_SIM_SELFUPDATE: 'current,previous=1.1.0' }, async (t) => {
  await t.click('Settings');
  await t.click('Advanced');
  await t.click('Open anyway');
  await t.click('Launcher');
  await t.expect(t.waitFor('Previous version'), 'Reiter Launcher: Zeile „Previous version“');
  await t.expect(t.has('1.1.0'), 'Zusatz nennt die Version');
  await t.expect(t.eval('document.getElementById("ch").value === "stable"'), 'Kanal steht auf „Stable“');
  await t.expect(t.eval('document.querySelector("[data-act=resetAll]").disabled'), '„Reset all“ gesperrt ohne Abweichung');
  await t.expect(t.setSelect('ch', 'beta'), 'Kanal auf Beta gestellt');
  await t.expect(t.waitUntil(async () => (await t.snapshot()).updateChannel === 'beta'), 'Kanal im Zustand');
  await t.expect(t.eval('!document.querySelector("[data-act=resetAll]").disabled'), 'Kanal zählt als Abweichung („Reset all“ aktiv)');
  await t.click('Reset all');
  await t.expect(t.waitUntil(async () => (await t.snapshot()).updateChannel === 'stable'), '„Reset all“ setzt den Kanal zurück');
  await t.clickSel('[data-act=prevAsk]');
  await t.expect(t.waitFor('Start version 1.1.0?'), 'Dialog „Start version 1.1.0?“');
  await t.expect(t.has(`Rollout restarts and skips version ${ownVersion()}.`), 'Dialogtext nennt die laufende Version');
  await t.expect((async () => (await t.focus()) === 'Cancel')(), 'Hauptknopf ist „Cancel“');
  await t.shot('1-vorherige');
  await t.click('Cancel');
  await t.expect((async () => { await sleep(400); return !(await t.has('Start version 1.1.0?')); })(), 'Abbrechen schließt den Dialog');
  await t.clickSel('[data-act=prevAsk]');
  await t.waitFor('Start version');
  await t.clickSel('[data-act=prevNow]');
  await t.expect(t.waitUntil(async () => (await t.snapshot()).selfUpdate.version === '1.1.0'), 'Starten löst den Wechsel aus (Attrappe)');
});

await session('su-launcher-blockiert', { ROLLOUT_SIM_SELFUPDATE: 'current,previous=1.1.0,blocked' }, async (t) => {
  await t.click('Settings');
  await t.click('Advanced');
  await t.click('Open anyway');
  await t.click('Launcher');
  await t.expect(t.eval('document.querySelector("[data-act=prevAsk]").disabled'), 'Belegt: „Start“ der vorherigen Version gesperrt');
});

// S4: Screenshots und Layout bei 1024 × 640 und 1280 × 800 in pl, pt, fr, de
for (const lang of ['pl', 'pt', 'fr', 'de']) {
  await session(`s4-${lang}`, { ROLLOUT_SIM_LANG: lang, ROLLOUT_SIM_SELFUPDATE: 'ready' }, async (t) => {
    for (const [w, h] of [[1280, 800], [1024, 640]]) {
      await t.viewport(w, h);
      await sleep(400);
      const wrap = await t.eval(`(() => {
        const items = [...document.querySelectorAll('.topactions > *')];
        const tops = items.map((el) => Math.round(el.getBoundingClientRect().top));
        const right = Math.max(...items.map((el) => el.getBoundingClientRect().right));
        return { n: items.length, sameRow: Math.max(...tops) - Math.min(...tops) <= 2, fits: right <= window.innerWidth, scroll: document.documentElement.scrollWidth <= window.innerWidth,
                 text: getComputedStyle(document.querySelector('.su-hint .su-text')).display !== 'none', height: document.querySelector('.topactions').getBoundingClientRect().height };
      })()`);
      await t.expect(Promise.resolve(wrap.n === 4 && wrap.sameRow && wrap.fits && wrap.scroll), `S4 ${lang} ${w}×${h}: Kopfzeile ohne Umbruch (${JSON.stringify(wrap)})`);
      await t.expect(Promise.resolve(wrap.text === (w >= 1180)), `S4 ${lang} ${w}×${h}: ${w >= 1180 ? 'Knopf mit Text' : 'Knopf nur mit Symbol'}`);
      await t.shot(`start-${w}x${h}`);
    }
    await t.click(await t.eval('document.querySelector(".top .btn:nth-last-child(2)").textContent.trim()'));
    for (const [w, h] of [[1280, 800], [1024, 640]]) {
      await t.viewport(w, h);
      await sleep(400);
      await t.expect(t.eval('document.documentElement.scrollWidth <= window.innerWidth'), `S4 ${lang} ${w}×${h}: Einstellungen ohne waagerechtes Scrollen`);
      await t.shot(`einstellungen-${w}x${h}`);
    }
  });
}

// ---------- Launcher-Update: Durchlauf mit echtem Electron und Wächter (S5 bis S8) ----------
const electronDir = process.env.ROLLOUT_ELECTRON_DIR || (fs.existsSync(path.join('node_modules/electron/dist/electron')) ? path.resolve('node_modules/electron/dist') : null);
if (!electronDir) console.log('s5-s8\n  – übersprungen: ROLLOUT_ELECTRON_DIR zeigt auf keinen Electron-Ordner');
else if (!fs.existsSync('dist/main/main.js')) console.log('s5-s8\n  – übersprungen: dist/ fehlt, erst npm run build');
else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-smoke-update-'));
  const ev = electronVersionOf(electronDir);
  const N = ownVersion();
  const N1 = bumpVersion(N);
  const fresh = (name) => {
    const home = path.join(tmp, `${name}-home`);
    const feedDir = path.join(tmp, `${name}-feed`);
    installBase({ home, electronDir });
    fs.mkdirSync(feedDir, { recursive: true });
    return { home, feedDir, key: testKey() };
  };

  // S5 und S8: Version N sieht N+1, lädt, Knopf, Neustart. Danach „Vorherige Version“.
  {
    const { home, feedDir, key } = fresh('s5');
    publish({ feedDir, key, version: N1, runtime: keepRuntime(ev) });
    await withHome('s5-durchlauf', home, feedDir, key, { env: {}, config: 'auto_update = false\n', shots: process.env.ROLLOUT_SHOTS }, async (t) => {
      await t.expect(t.waitUntil(async () => !(await noHint(t))), `S5 ${N} sieht ${N1}: Knopf „Update Rollout“ erscheint`);
      await t.click('Update Rollout');
      await t.expect(t.waitFor(`Version ${N1} · `), 'S5 Einstellungen nennen die neue Version');
      await t.shot('1-verfuegbar');
      await t.click('Download');
      await t.expect(t.waitFor(`Version ${N1} is ready`, 30000), 'S5 geladen, „ist bereit“');
      await t.expect(Promise.resolve(stateFile(home, 'pending') === `${N1}\n` && linkOf(home, 'current') === N), 'S5 pending liegt, current ist noch N');
      await t.shot('2-bereit');
      await t.click('Restart now');
      await t.reattach(60000);
      await t.click('Settings');
      await t.expect(t.waitFor(`Rollout ${N1}`), `S5 Einstellungen zeigen ${N1}`);
      await t.expect(t.waitUntil(() => stateFile(home, 'trial') === null, 20000), 'S5 state/trial weg (Probe bestanden)');
      await t.expect(Promise.resolve(linkOf(home, 'previous') === N && linkOf(home, 'current') === N1 && stateFile(home, 'pending') === null), `S5 previous zeigt auf ${N}`);
      await t.expect(t.waitFor('Up to date'), 'S5 „Up to date“');
      await t.shot('3-neu');

      // S8: Vorherige Version
      await t.click('Advanced');
      await t.click('Open anyway');
      await t.click('Launcher');
      await t.expect(t.waitFor('Previous version'), 'S8 Zeile „Previous version“');
      await t.clickSel('[data-act=prevAsk]');
      await t.expect(t.waitFor(`Start version ${N}?`), 'S8 Dialog');
      await t.clickSel('[data-act=prevNow]');
      await t.reattach(60000);
      await t.click('Settings');
      await t.expect(t.waitFor(`Rollout ${N}`), `S8 läuft wieder auf ${N}`);
      await t.expect(Promise.resolve((stateFile(home, 'bad') ?? '').split('\n').includes(N1) && linkOf(home, 'current') === N), `S8 ${N1} steht in bad`);
      await t.click('Check');
      await t.expect(t.waitFor('Up to date', 15000), `S8 ${N1} wird nicht erneut angeboten`);
      await t.expect(Promise.resolve(stateFile(home, 'pending') === null), 'S8 kein pending');
    });
  }

  // S6: Release mit throw in main.js
  {
    const { home, feedDir, key } = fresh('s6');
    publish({ feedDir, key, version: N1, runtime: keepRuntime(ev), mutate: (stage) => {
      const file = path.join(stage, 'dist/main/main.js');
      fs.writeFileSync(file, `throw new Error('absichtlich');\n${fs.readFileSync(file, 'utf8')}`);
    } });
    await withHome('s6-fehlstart', home, feedDir, key, { env: {}, shots: process.env.ROLLOUT_SHOTS }, async (t) => {
      await t.expect(stageUpdate(t).then((problem) => problem === null), `S6 ${N1} (mit Fehler) geladen und bereit`);
      await t.eval('void window.rollout.restartForUpdate(); true');
      await t.reattach(120000);
      await t.expect(t.waitUntil(async () => (await t.snapshot()).selfUpdate.version === N), `S6 nach zwei Versuchen läuft wieder ${N}`);
      await t.expect(t.waitFor('Update undone', 10000), 'S6 Hinweis „Update undone“ erscheint');
      await t.expect(Promise.resolve((stateFile(home, 'bad') ?? '').split('\n').includes(N1) && linkOf(home, 'current') === N && stateFile(home, 'trial') === null), `S6 ${N1} in bad, current ${N}, trial weg`);
      await t.shot('1-hinweis');
      await t.click('OK');
      await t.expect((async () => { await sleep(500); return !(await t.has('Update undone')) && stateFile(home, 'notice') === null; })(), 'S6 Hinweis nach OK weg, notice gelöscht');
      await t.click('Settings');
      await t.click('Check');
      await t.expect(t.waitFor('Up to date', 15000), 'S6 die Version wird nicht erneut geladen');
      await t.expect(Promise.resolve(stateFile(home, 'pending') === null), 'S6 kein pending');
      const log = stateFile(home, 'boot.log') ?? '';
      await t.expect(Promise.resolve(/zurück auf/.test(log)), 'S6 boot.log nennt den Rollback');
    });
  }

  // S7: Manifest manipuliert, Ordner leer (offline)
  {
    const { home, feedDir, key } = fresh('s7a');
    publish({ feedDir, key, version: N1, runtime: keepRuntime(ev) });
    const file = path.join(feedDir, 'rollout-update.json');
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...envelope, signed: envelope.signed.replace(N1, '9.9.9') }));
    await withHome('s7-manipuliert', home, feedDir, key, { env: {}, shots: process.env.ROLLOUT_SHOTS }, async (t) => {
      await sleep(2500);
      await t.expect(Promise.resolve(stateFile(home, 'pending') === null), 'S7 manipuliertes Manifest: kein pending');
      await t.expect(t.has('Ride'), 'S7 App bedienbar (Karte mit „Ride“), kein Fehlerbild');
      await t.expect(noHint(t), 'S7 kein Update-Knopf');
      await t.click('Settings');
      await t.click('Check');
      await t.expect(t.waitFor('Update failed its check', 10000), 'S7 von Hand: „Update failed its check“');
      await t.shot('1-manipuliert');
    });
  }
  {
    const { home, feedDir, key } = fresh('s7b');
    fs.mkdirSync(feedDir, { recursive: true });
    await withHome('s7-offline', home, feedDir, key, { env: {}, shots: process.env.ROLLOUT_SHOTS }, async (t) => {
      await sleep(2500);
      await t.expect(Promise.resolve(stateFile(home, 'pending') === null), 'S7 Ordner leer: kein pending');
      await t.expect(t.has('Ride'), 'S7 App bedienbar');
      await t.click('Settings');
      await t.click('Check');
      await t.expect(t.waitFor("Couldn't check right now", 10000), 'S7 von Hand: „Couldn\'t check right now“');
    });
  }

  // A2: Electron-Tausch. 45.2.2 ist hier eine Hülle um das vorhandene Electron, die die Versionsabfrage des Probelaufs beantwortet und sonst
  // dorthin weiterreicht: Geprüft werden Laden, Probelauf, Tausch, Rollback und Aufräumen, nicht Chromium 45.2.2 selbst.
  {
    const wrapVersion = '45.2.2';
    const wrap = path.join(tmp, 'wrap');
    fs.mkdirSync(wrap);
    fs.writeFileSync(path.join(wrap, 'electron'), `#!/bin/sh\ncase "$*" in *process.versions.electron*) echo ${wrapVersion}; exit 0 ;; esac\nexec "${electronDir}/electron" "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(wrap, 'version'), `${wrapVersion}\n`);
    const runtimeArchive = (feedDir, releaseVersion) => {
      const file = path.join(feedDir, `rollout-runtime-electron-${wrapVersion}-linux-x64.tar.gz`);
      return packElectron({ electronDir: wrap, electronVersion: wrapVersion, releaseVersion, outFile: file });
    };
    const toThrow = (stage) => {
      const file = path.join(stage, 'dist/main/main.js');
      fs.writeFileSync(file, `throw new Error('absichtlich');\n${fs.readFileSync(file, 'utf8')}`);
    };
    const exists = (home, rel) => fs.existsSync(path.join(home, rel));

    // Erfolgreicher Tausch, danach ein zweites Update: Der alte Electron-Ordner bleibt, solange previous ihn braucht, und verschwindet erst danach.
    {
      const { home, feedDir, key } = fresh('a2');
      const N2 = bumpVersion(N1);
      publish({ feedDir, key, version: N1, runtime: { ...runtimeArchive(feedDir, N1), min: wrapVersion } });
      await withHome('a2-electron-tausch', home, feedDir, key, { env: {} }, async (t) => {
        await t.expect(stageUpdate(t).then((problem) => problem === null), `A2 ${N1} mit Electron ${wrapVersion} geladen und bereit`);
        await t.expect(Promise.resolve(exists(home, `electron/${wrapVersion}/electron`) && fs.readFileSync(path.join(home, 'versions', N1, 'runtime'), 'utf8') === `${wrapVersion}\n`), 'A2 neues Electron liegt neben dem alten, runtime nennt es');
        await t.expect(Promise.resolve(exists(home, `electron/${ev}/electron`)), 'A2 altes Electron bleibt liegen');
        await t.eval('void window.rollout.restartForUpdate(); true');
        await t.reattach(60000);
        await t.expect(t.waitUntil(async () => (await t.snapshot()).selfUpdate.version === N1), `A2 läuft auf ${N1}`);
        await t.expect(t.waitUntil(() => stateFile(home, 'trial') === null, 20000), 'A2 Probe mit dem neuen Electron bestanden');
        await sleep(6000);
        await t.expect(Promise.resolve(exists(home, `electron/${ev}/electron`) && exists(home, `versions/${N}`)), 'A2 Aufräumen lässt N und sein Electron stehen, solange previous sie braucht');
        publish({ feedDir, key, version: N2, runtime: keepRuntime(wrapVersion) });
        await t.expect(stageUpdate(t).then((problem) => problem === null), `A2 ${N2} bereit`);
        await t.eval('void window.rollout.restartForUpdate(); true');
        await t.reattach(60000);
        await t.expect(t.waitUntil(async () => (await t.snapshot()).selfUpdate.version === N2), `A2 läuft auf ${N2}`);
        await t.expect(t.waitUntil(() => !exists(home, `electron/${ev}`) && !exists(home, `versions/${N}`), 30000), 'A2 danach entfernt das Aufräumen den alten Electron-Ordner und die alte Version');
        await t.expect(Promise.resolve(exists(home, `electron/${wrapVersion}/electron`) && linkOf(home, 'previous') === N1), 'A2 current und previous behalten ihr Electron');
      });
    }

    // Fehlstart mit neuem Electron: Rollback schaltet Electron mit zurück.
    {
      const { home, feedDir, key } = fresh('a2r');
      publish({ feedDir, key, version: N1, runtime: { ...runtimeArchive(feedDir, N1), min: wrapVersion }, mutate: toThrow });
      await withHome('a2-electron-rollback', home, feedDir, key, { env: {} }, async (t) => {
        await t.expect(stageUpdate(t).then((problem) => problem === null), `A2 ${N1} (mit Fehler, Electron ${wrapVersion}) bereit`);
        await t.eval('void window.rollout.restartForUpdate(); true');
        await t.reattach(120000);
        await t.expect(t.waitUntil(async () => (await t.snapshot()).selfUpdate.version === N), `A2 Rollback: läuft wieder ${N}`);
        await t.expect(Promise.resolve(fs.readFileSync(path.join(home, 'versions', N, 'runtime'), 'utf8') === `${ev}\n` && linkOf(home, 'current') === N), 'A2 Rollback: alte Version mit altem Electron');
        await t.expect(t.waitUntil(() => !exists(home, `electron/${wrapVersion}`) && !exists(home, `versions/${N1}`), 30000), 'A2 Aufräumen entfernt das nicht bewährte Electron und die Version erst danach');
      });
    }
  }

  // A3: Zurück auf eine ältere Electron-Hauptversion (45 → 44) mit demselben Profil. Braucht ROLLOUT_ELECTRON_OLD (Ordner mit Electron 44).
  if (process.env.ROLLOUT_ELECTRON_OLD) {
    const profile = path.join(tmp, 'a3-profile');
    const cfg = path.join(tmp, 'a3-config');
    const shared = { userData: profile, configHome: cfg, home: path.join(tmp, 'a3-home') };
    await session('a3-electron-45', {}, async (t) => {
      await t.click('Settings');
      await t.click('Advanced');
      await t.click('Open anyway');
      await t.click('Launcher');
      await t.expect(t.setSelect('ch', 'beta'), 'A3 mit Electron 45: Kanal auf Beta gestellt');
      await t.expect(t.waitUntil(async () => (await t.snapshot()).updateChannel === 'beta'), 'A3 Kanal im Zustand');
      await sleep(1500);
    }, { ...shared, electron: path.join(electronDir, 'electron') });
    await session('a3-electron-44', {}, async (t) => {
      await t.expect(t.waitUntil(async () => (await t.snapshot())?.updateChannel === 'beta'), 'A3 mit Electron 44, gleiches Profil: Fenster öffnet, Einstellung bleibt');
      await t.expect(t.eval('navigator.userAgent.includes("Electron/44.")'), 'A3 läuft wirklich auf Electron 44');
    }, { ...shared, electron: path.join(process.env.ROLLOUT_ELECTRON_OLD, 'electron') });
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

// Im Gaming Mode liegen Testfenster in Gamescope, dort sind die Maße nicht vergleichbar.
const inGamingMode = spawnSync('pgrep', ['-f', 'gamescope-session']).status === 0;
if (inGamingMode) console.log('vollbild-aus-steam\n  – übersprungen: Gaming Mode läuft');
else {
await session('vollbild-aus-steam', { SteamGameId: '1' }, async (t) => {
  await t.expect(t.eval('window.innerWidth === screen.width && window.innerHeight === screen.height'), 'Start aus Steam im Vollbild');
  await t.shot('1-vollbild');
});
}

const evalFocusId = (t) => t.eval('document.activeElement && document.activeElement.id');

await session('aussehen', { ROLLOUT_SIM_LANG: 'en' }, async (t) => {
  const isLight = () => t.eval('document.getElementById("root").classList.contains("light")');
  await t.click('Settings');
  await t.expect(t.clickSel('#theme'), 'Auswahl „Appearance“ geöffnet');
  await t.expect(t.waitFor('Light'), 'Liste mit Automatic, Dark, Light');
  await t.click('Light');
  await t.expect((async () => { await sleep(500); return await isLight(); })(), 'Hell wird sofort angewendet');
  await t.shot('1-hell-einstellungen');
  await t.expect(t.clickSel('#theme'), 'Auswahl erneut geöffnet');
  await t.click('Dark');
  await t.expect((async () => { await sleep(500); return !(await isLight()); })(), 'Dunkel wird angewendet');
  await t.expect(t.clickSel('#theme'), 'Auswahl ein drittes Mal geöffnet');
  await t.click('Automatic');
  await t.expect((async () => { await sleep(500); return typeof (await isLight()) === 'boolean'; })(), 'Automatisch folgt dem System');
});

await session('touch-dann-tasten', { ROLLOUT_SIM_LANG: 'en' }, async (t) => {
  const nav = () => t.eval('document.documentElement.classList.contains("nav")');
  await t.eval('document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); document.activeElement && document.activeElement.blur(); true');
  await t.expect((async () => !(await nav()))(), 'Nach Touch ist der Fokusring aus');
  await t.eval('window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); true');
  await t.expect((async () => (await nav()) && (await t.eval('document.activeElement !== document.body')))(), 'Erste Taste nach Touch findet den Fokus wieder und zeigt den Ring');
  await t.eval('document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); true');
  await t.expect((async () => !(await nav()))(), 'Touch blendet den Ring wieder aus');
});

await session('hell-start', { ROLLOUT_SIM_THEME: 'light' }, async (t) => {
  await t.expect(t.eval('document.getElementById("root").classList.contains("light")'), 'Start im hellen Design');
  await t.shot('1-hell-start');
  await t.click('Settings');
  await t.click('Advanced');
  await t.click('Open anyway');
  await t.click('Bluetooth');
  await t.expect(t.clickSel('#ad'), 'Adapter-Liste geöffnet');
  await t.expect(t.waitFor('hci1 · USB'), 'Adapter-Liste zeigt alle Adapter');
  await t.shot('2-hell-adapter-liste');
  await t.expect(t.eval('(() => { const p = document.querySelector(".picker"); return p.scrollWidth <= p.clientWidth + 1; })()'), 'Liste ohne seitliches Abschneiden');
});

// Nur von Hand mit ROLLOUT_REAL_BT=1: sucht mit dem echten Adapter und zeigt, was in der Nähe sendet.
if (process.env.ROLLOUT_REAL_BT === '1') {
  await session('bluetooth-echt', { ROLLOUT_BT: 'real' }, async (t) => {
    await t.click('Bluetooth');
    await t.waitFor('Sensors nearby');
    await sleep(Number(process.env.ROLLOUT_REAL_BT_WAIT || 20000));
    console.log((await t.text()).split('\n').filter(Boolean).join(' | '));
    await t.shot('1-bluetooth-echt');
  });
}

await session('beenden', {}, async (t) => {
  await t.expect(t.click('Quit Rollout'), 'Beenden-Knopf neben den Einstellungen');
  await t.expect(t.waitFor('Quit Rollout?'), 'Rückfrage vor dem Beenden');
  await t.expect(t.has('Running installs and updates keep going.'), 'Hinweistext');
  await t.expect((async () => (await t.focus()) === 'Cancel')(), 'Fokus auf „Cancel“ (Hauptknopf)');
  await t.shot('1-beenden-dialog');
  await t.click('Cancel');
  await t.expect((async () => { await sleep(400); return !(await t.has('Quit Rollout?')); })(), 'Abbrechen schließt den Dialog');
  await t.expect((async () => (await t.exited(1500)) === false)(), 'App läuft nach „Cancel“ weiter');
  await t.click('Quit Rollout');
  await t.waitFor('Quit Rollout?');
  await Promise.race([t.click('Quit'), t.exited(8000)]);
  await t.expect(t.exited(8000), 'App beendet sich nach „Quit“');
});

await session('groesse', {}, async (t) => {
  const width = () => t.eval('window.innerWidth');
  const before = await width();
  await t.click('Settings');
  await t.expect(t.clickSel('#scale'), 'Auswahl „Interface size“ geöffnet');
  await t.expect(t.waitFor('125 %'), 'Liste mit Automatic und den Prozentwerten');
  await t.click('125 %');
  await sleep(700);
  const after = await width();
  await t.expect(Promise.resolve(Math.abs(before / after - 1.25) < 0.03), `Oberfläche um 125 % vergrößert (${before} → ${after} px Breite)`);
  await t.shot('1-groesse');
});

const SPRACHEN = { es: 'Listo', fr: 'Prêt', it: 'Pronto', pt: 'Pronto', nl: 'Klaar', pl: 'Gotowe' };
for (const [code, word] of Object.entries(SPRACHEN)) {
  await session(`sprache-${code}`, { ROLLOUT_SIM_LANG: code }, async (t) => {
    await t.expect(t.has(word), `Startseite in „${code}“`);
  });
}

await session('sprache-wechseln', {}, async (t) => {
  await t.click('Settings');
  await t.expect(t.waitFor('Download updates automatically'), 'Einstellungen auf Englisch');
  await t.expect(t.clickSel('#lang'), 'Sprachliste geöffnet');
  await t.expect(t.waitFor('Français'), 'eigene Liste mit allen Sprachen');
  await t.expect((async () => (await t.focus()) === 'English')(), 'Fokus auf der gewählten Sprache');
  await t.shot('1-sprachliste');
  await t.expect(t.click('Français'), 'Sprache gewählt');
  await t.expect(t.waitFor('Télécharger les mises à jour automatiquement'), 'Oberfläche wechselt sofort die Sprache');
  await t.expect((async () => { await sleep(300); return (await evalFocusId(t)) === 'lang'; })(), 'Fokus zurück auf der Auswahl');
});

failuresExit();
