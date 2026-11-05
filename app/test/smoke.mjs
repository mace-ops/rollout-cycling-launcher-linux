// Click test: starts the app with a simulated state, walks through all views and checks key texts.
// Usage: ELECTRON_BIN=<electron> ELECTRON_RUN_AS_NODE=1 <electron> test/smoke.mjs   (Electron ships Node with WebSocket)
// Optional: ROLLOUT_SHOTS=<dir> saves one screenshot per view, ROLLOUT_ONLY=<name> runs only matching scenarios.
// The frame, fakes and throwaway directories live in test/harness.mjs.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { failuresExit, session, sleep, testKey } from './harness.mjs';
import { bumpVersion, electronVersionOf, packElectron } from '../scripts/release.mjs';
import { installBase, keepRuntime, linkOf, ownVersion, publish, stageUpdate, stateFile, withHome } from './update-probe.mjs';

await session('fresh', { ROLLOUT_SIM_STATE: 'fresh' }, async (t) => {
  await t.expect(t.has('Not installed · downloads 4 GB'), 'MyWhoosh not installed');
  await t.shot('1-start');
  await t.click('Install');
  await t.expect(t.waitFor('Install MyWhoosh'), 'Installieren-Ansicht');
  await t.shot('2-install');
  await t.click('Back');
  await t.expect(t.waitFor('Settings'), 'back to the overview');
  await t.expect(t.clickSel('article[data-tone=zwift] .btn.primary'), 'Zwift-Karte angeklickt');
  await t.expect(t.waitFor('Not officially supported by Zwift'), 'Zwift-Hinweis');
  await t.shot('3-zwift');
  await t.click('Install');
  await t.expect(t.waitFor('is being installed'), 'Fortschritt-Ansicht');
  await sleep(2500);
  await t.shot('4-progress');
  await t.expect(t.waitFor('is ready', 25000), 'Installation fertig');
  await t.shot('5-done');
  await t.click('Ride');
  await t.expect(t.waitFor('Running', 15000), 'game is running');
  await t.shot('6-running');
  await t.click('Quit game');
  await t.expect(t.waitFor('Settings'), 'back in the overview');
});

// Zwift through the adapter fake (ROLLOUT_ZWIFT=fake): script and image come from the service, not from the simulation.
// Before downloading, a dialog asks with tag and size; starting goes through the service (phases from its output).
await session('zwift-fake', { ROLLOUT_SIM_STATE: 'fresh', ROLLOUT_ZWIFT: 'fake', ROLLOUT_ZWIFT_RUNNING_MS: '1500' }, async (t) => {
  await t.expect(t.clickSel('article[data-tone=zwift] .btn.primary'), 'Zwift-Karte angeklickt');
  await t.expect(t.waitFor('Not officially supported by Zwift'), 'Zwift-Hinweis');
  await t.click('Install');
  await t.expect(t.waitFor('Download the Zwift image?'), 'Zustimmungsdialog');
  await t.expect(t.has('version 1.0.0, about 6 GB'), 'dialog names tag and size');
  await t.expect((async () => (await t.focus()) === 'Download')(), 'focus on "Download"');
  await t.shot('1-consent');
  await t.click('Cancel');
  await t.expect((async () => !(await t.has('Download the Zwift image?')))(), 'Dialog geschlossen, nichts geladen');
  await t.expect(t.has('Install Zwift'), 'still in the install view');
  await t.click('Install');
  await t.click('Download');
  await t.expect(t.waitFor('is being installed'), 'Fortschritt-Ansicht');
  await t.expect(t.waitFor('is ready', 25000), 'installation through the service finished');
  await t.click('Ride');
  await t.expect(t.waitFor('Starting Zwift', 15000), 'phase "Starting Zwift" from the output');
  await t.shot('2-starting');
  await t.expect(t.waitFor('Running', 15000), 'game is running');
  await t.expect((async () => !(await t.has('Bluetooth')))(), 'Zwift does not check Bluetooth');
  await t.click('Quit game');
  await t.expect(t.waitFor('Settings'), 'back in the overview');
  await t.expect(t.waitFor('Closing …', 3000), 'card shows "Closing …" while Zwift is being closed');
  await t.expect((async () => !(await t.eval(`document.querySelector('article[data-tone=zwift] .btn.primary').disabled === false`)))(), 'Knopf „Ride“ in dieser Zeit gesperrt');
  await t.expect(t.waitUntil(async () => (await t.snapshot()).launch === null), 'Start beendet');
  await t.expect(t.waitFor('Ready'), 'card shows "Ready" again');
});

// Install problems: reason as a sentence in the install view, pill on the card, retry possible.
for (const [mode, text] of [['nonet', 'could not download the Zwift start script'], ['nopull', 'image could not be downloaded'], ['norun', 'Podman or Docker is not working']]) {
  await session(`zwift-problem-${mode}`, { ROLLOUT_SIM_STATE: 'fresh', ROLLOUT_ZWIFT: 'fake', ROLLOUT_SIM_ZWIFT: mode }, async (t) => {
    if (mode === 'norun') {
      await t.expect(t.waitUntil(async () => (await t.has('Needs attention'))), '"Needs attention" pill on the card, even before an attempt');
    } else {
      await t.expect(t.clickSel('article[data-tone=zwift] .btn.primary'), 'Zwift-Karte angeklickt');
      await t.click('Install');
      await t.click('Download');
      await t.expect(t.waitFor(text, 25000), `reason is shown in the install view (${mode})`);
    }
    if (mode === 'norun') await t.clickSel('article[data-tone=zwift] .btn.primary');
    await t.expect(t.waitFor(text, 10000), `Grund: ${text}`);
    await t.expect(t.has('Try again'), 'Knopf „Try again“');
    await t.shot('1-problem');
    await t.click('Back');
    await t.expect(t.waitFor('Needs attention'), 'pill on the card');
    await t.expect((async () => (await t.snapshot()).apps.mywhoosh.problem === '')(), 'MyWhoosh untouched');
  });
}

// Start problems: crash (exit 1 shortly after start) and "image missing" (exit 12) with reason and retry.
await session('zwift-start-crash', { ROLLOUT_SIM_STATE: 'fresh', ROLLOUT_ZWIFT: 'fake', ROLLOUT_SIM_ZWIFT: 'runcrash' }, async (t) => {
  await t.click('Ride');
  await t.expect(t.waitFor('closed right after starting', 15000), 'Absturz-Ansicht');
});
await session('zwift-start-error', { ROLLOUT_SIM_STATE: 'fresh', ROLLOUT_ZWIFT: 'fake', ROLLOUT_SIM_ZWIFT: 'runfail', ROLLOUT_SIM_LANG: 'de' }, async (t) => {
  await t.click('Losfahren');
  await t.expect(t.waitFor('ließ sich nicht starten', 15000), 'start failed (German)');
  await t.expect(t.has('Zwift-Image konnte nicht geladen werden'), 'reason in German');
  await t.shot('1-start-error');
  await t.click('Nochmal versuchen');
  await t.expect(t.waitFor('ließ sich nicht starten', 15000), 'retry possible');
  await t.click('Zurück');
});

// Removal: the confirmation names tag and size, then the image is gone; if it fails, Zwift stays and the row names the reason.
await session('zwift-remove', { ROLLOUT_SIM_STATE: 'fresh', ROLLOUT_ZWIFT: 'fake', ROLLOUT_SIM_ZWIFT: 'ready' }, async (t) => {
  await t.click('Settings');
  await t.click('Remove an app');
  await t.expect(t.clickSel('button[data-act=remove][data-arg=zwift]'), 'Remove for Zwift');
  await t.expect(t.waitFor('Remove Zwift?'), 'confirmation');
  await t.expect(t.has('version 1.0.0') , 'confirmation names the tag');
  await t.shot('1-remove');
  await t.clickSel('button[data-act=removeConfirm]');
  await t.expect(t.waitFor('No app is installed.', 10000), 'Zwift entfernt');
});
await session('zwift-remove-error', { ROLLOUT_SIM_STATE: 'fresh', ROLLOUT_ZWIFT: 'fake', ROLLOUT_SIM_ZWIFT: 'norem' }, async (t) => {
  await t.click('Settings');
  await t.click('Remove an app');
  await t.clickSel('button[data-act=remove][data-arg=zwift]');
  await t.clickSel('button[data-act=removeConfirm]');
  await t.expect(t.waitFor('The image could not be removed', 10000), 'reason in the row');
  await t.expect(t.has('Zwift'), 'Zwift stays in the list');
});

// Real Zwift with container fakes on PATH and a replaced upstream (never a real container; the real zwift.sh is loaded, verified
// and tried separately with DRYRUN). Needs network for the script from GitHub, hence only with ROLLOUT_ZWIFT_NET=1.
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
  await session('zwift-real', {
    ROLLOUT_SIM_STATE: 'fresh', ROLLOUT_ZWIFT: 'real', ROLLOUT_ZWIFT_RUNNING_MS: '1500',
    PATH: `${fakebin}:${process.env.PATH}`, ROLLOUT_RUN_UPSTREAM: path.join(home, 'up.sh'), ROLLOUT_RUN_NO_INHIBIT: '1'
  }, async (t) => {
    await t.expect(t.waitUntil(async () => (await t.snapshot()).zwiftTag !== ''), 'real service active (tag in the state)');
    await t.expect(t.clickSel('article[data-tone=zwift] .btn.primary'), 'Zwift-Karte angeklickt');
    await t.click('Install');
    await t.expect(t.waitFor('Download the Zwift image?'), 'Zustimmungsdialog');
    await t.shot('1-consent');
    await t.click('Download');
    await t.expect(t.waitFor('is ready', 60000), 'script loaded, checksum matches, image "pulled" (fake)');
    await t.expect(log().includes('pull docker.io/netbrain/zwift:'), 'pull only after consent, through the fake');
    await t.click('Ride');
    await t.expect(t.waitFor('Starting Zwift', 15000), 'phase from the starter output');
    await t.expect(t.waitFor('Running', 15000), 'running');
    await t.shot('2-running');
    await t.expect((async () => fs.existsSync(path.join(home, 'state/run.pid')))(), 'run.pid from the starter');
    await t.click('Quit game');
    await t.expect(t.waitUntil(async () => (await t.snapshot()).launch === null && !fs.existsSync(path.join(home, 'state/run.pid')), 15000), 'Spiel beendet, run.pid weg');
    await t.click('Settings');
    await t.click('Remove an app');
    await t.clickSel('button[data-act=remove][data-arg=zwift]');
    await t.expect(t.waitFor('Remove Zwift?'), 'confirmation');
    await t.clickSel('button[data-act=removeConfirm]');
    await t.expect(t.waitFor('No app is installed.', 15000), 'entfernt');
    await t.expect(log().includes('rmi docker.io/netbrain/zwift:'), 'podman rmi ran (fake)');
    await t.expect(!/ run /.test(log()), 'no container started');
    await t.expect(!fs.existsSync(path.join(home, 'state/zwift-image-ok')), 'Zustimmung vergessen');
  }, { home });
  fs.rmSync(home, { recursive: true, force: true });
}

await session('settings', {}, async (t) => {
  await t.click('Settings');
  await t.expect(t.waitFor('Download updates automatically'), 'Settings');
  await t.shot('1-settings');
  await t.click('MyWhoosh in Steam');
  await t.expect(t.waitFor('Steam needs to restart briefly'), 'Steam-Dialog');
  await t.expect((async () => (await t.focus()) === 'Restart now')(), 'focus in the dialog on the primary button');
  await t.shot('2-dialog');
  await t.click('Do it later');
  await t.expect((async () => !(await t.has('Steam needs to restart briefly')))(), 'Dialog geschlossen');
  await t.click('Get help');
  await t.click('Create file');
  await t.expect(t.waitFor('Downloads'), 'Hilfe-Datei');
  await t.shot('3-help');
  await t.click('Back');
  await t.click('Remove an app');
  await t.click('Remove');
  await t.expect(t.waitFor('Remove MyWhoosh?'), 'confirmation before removal');
  await t.shot('4-remove-dialog');
  await t.click('Cancel');
  await t.expect(t.has('Uses 8 GB'), 'app still there after cancelling');
  await t.click('Back');
  await t.click('Advanced');
  await t.expect(t.waitFor('Here you can change things'), 'Abfrage vor Erweitert');
  await t.shot('5-prompt');
  await t.click('Open anyway');
  await t.expect(t.waitFor('Proton version'), 'Advanced');
  await t.shot('6-advanced');
  await t.click('Bluetooth');
  await t.expect(t.waitFor('Bluetooth adapter'), 'Reiter Bluetooth');
  await t.click('Launcher');
  await t.expect(t.waitFor('Update channel'), 'Reiter Launcher');
});

await session('bluetooth', { ROLLOUT_SIM_BT: 'problem' }, async (t) => {
  await t.expect(t.clickSel('button[data-act=appMenu][data-arg=mywhoosh]'), 'gear on the MyWhoosh card');
  await t.expect(t.waitFor('Check Bluetooth'), 'Bluetooth problem in the MyWhoosh menu');
  await t.click('Check Bluetooth');
  await t.expect(t.waitFor('Nothing found yet', 15000), 'search without result');
  await t.shot('1-bluetooth-problem');
  await t.click('Back');
  await t.click('Back');
  await t.click('Ride');
  await t.expect(t.waitFor('Your trainer was not found', 15000), 'Fehleransicht Trainer');
  await t.shot('2-error');
  await t.click('Start anyway');
  await t.expect(t.waitFor('Running', 15000), 'trotzdem gestartet');
});

await session('bluetooth-ok', {}, async (t) => {
  await t.clickSel('button[data-act=appMenu][data-arg=mywhoosh]');
  await t.click('Bluetooth ready');
  await t.expect(t.waitFor('All there.', 15000), 'trainer and strap found');
  await t.shot('1-bluetooth');
});

await session('update-crash', { ROLLOUT_SIM_UPDATE: '1', ROLLOUT_SIM_CRASH: '1' }, async (t) => {
  await t.expect(t.has('Update available'), 'Update angezeigt');
  await t.click('Update');
  await t.expect(t.waitFor('is being updated'), 'update is running');
  await t.shot('1-update');
  await t.expect(t.waitFor('is up to date', 25000), 'Update fertig');
  await t.click('Ride');
  await t.expect(t.waitFor('closed right after starting', 15000), 'Absturz-Ansicht');
  await t.shot('2-crash');
});

await session('german', { ROLLOUT_SIM_LANG: 'de' }, async (t) => {
  await t.expect(t.has('Bereit'), 'home page in German');
  await t.click('Einstellungen');
  await t.expect(t.waitFor('Updates automatisch laden'), 'settings in German');
  await t.shot('1-settings-de');
});

await session('steam-off', {}, async (t) => {
  await t.click('Settings');
  await t.expect(t.waitFor('Rollout in Steam'), 'Zeile „Rollout in Steam“');
  if (process.env.ROLLOUT_DEBUG) console.log('vorher', await t.eval('window.rollout.getSnapshot().then((s) => JSON.stringify(s.rolloutSteam))'));
  await t.click('Rollout in Steam');
  await sleep(1500);
  if (process.env.ROLLOUT_DEBUG) console.log('nachher', await t.eval('window.rollout.getSnapshot().then((s) => JSON.stringify(s.rolloutSteam))'), await t.eval('document.querySelectorAll(".modalbg").length'));
  await t.expect(t.waitFor('Rollout appears in your Steam library.'), 'entry created without restart (Steam closed)');
  await t.shot('1-steam-entry');
  await t.click('Rollout in Steam');
  await t.expect((async () => { await sleep(600); return !(await t.has('Rollout appears in your Steam library.')); })(), 'entry removed again');
});

await session('steam-running', { ROLLOUT_SIM_STEAM_RUNNING: '1' }, async (t) => {
  await t.click('Settings');
  await t.click('Rollout in Steam');
  await t.expect(t.waitFor('Steam closes and opens again'), 'dialog with explanation because Steam is running');
  await t.expect((async () => (await t.focus()) === 'Restart now')(), 'focus on "Restart now"');
  await t.shot('1-steam-dialog');
  await t.click('Restart now');
  await t.expect(t.waitFor('Rollout appears in your Steam library.'), 'entry created after restart');
});

// ---------- Launcher update: UI (S1 to S4) ----------
const noHint = (t) => t.eval('!document.querySelector(".su-hint")');
const suBtn = (t) => t.eval('(() => { const b = document.getElementById("su-btn"); return b ? { text: b.textContent.trim(), disabled: b.disabled } : null; })()');
const suNote = (t) => t.eval('document.getElementById("su-note")?.innerText ?? ""');

const SU_STATES = [
  ['none', '', async (t) => {
    await t.expect((async () => (await suBtn(t)) === null && (await suNote(t)) === '')(), 'Without watcher: no extra line, no button');
  }],
  ['current', '', async (t) => {
    await t.expect((async () => (await suNote(t)) === 'Up to date' && (await suBtn(t))?.text === 'Check')(), 'Aktuell: „Up to date“, Knopf „Check“');
  }],
  ['checking', '', async (t) => {
    await t.expect((async () => (await suNote(t)) === 'Checking' && (await suBtn(t))?.disabled === true)(), 'Checking: "Checking", button disabled');
    await t.expect(t.eval('!!document.querySelector("#su-note .spin")'), 'Checking: spinner');
  }],
  ['checkFailed', '', async (t) => {
    await t.expect((async () => (await suNote(t)).includes("Couldn't check right now") && (await suBtn(t))?.text === 'Check')(), 'check failed');
  }],
  ['available', '', async (t) => {
    await t.expect((async () => (await suNote(t)) === 'Version 1.3.0 · 5 MB' && (await suBtn(t))?.text === 'Download')(), 'Update available: version and size, "Download" button');
  }],
  ['available,mb=129', '', async (t) => {
    await t.expect((async () => (await suNote(t)) === 'Version 1.3.0 · 129 MB')(), 'update with new Electron: 129 MB');
  }],
  ['downloading', '', async (t) => {
    await t.expect((async () => (await suNote(t)).includes('Downloading · 42 %') && (await suBtn(t))?.text === 'Cancel')(), 'Downloading: "Downloading · 42 %", "Cancel" button');
    await t.expect(t.eval('(() => { const i = document.getElementById("su-bar"); return !!i && i.style.width === "42%"; })()'), 'Downloading: bar at 42 %');
  }],
  ['ready', '', async (t) => {
    await t.expect((async () => (await suNote(t)) === 'Version 1.3.0 is ready' && (await suBtn(t))?.text === 'Restart now' && !(await suBtn(t)).disabled)(), 'Ready: text and "Restart now" button');
  }],
  ['ready,blocked', '', async (t) => {
    await t.expect((async () => (await suNote(t)) === 'Applied the next time Rollout starts' && (await suBtn(t))?.disabled === true)(), 'Bereit, belegt: „Applied the next time…“, Knopf gesperrt');
  }],
  ['invalid', '', async (t) => {
    await t.expect((async () => (await suNote(t)) === 'Update failed its check' && (await suBtn(t))?.text === 'Check')(), 'check not passed');
    await t.expect(t.eval('getComputedStyle(document.querySelector("#su-note .warntext")).color !== getComputedStyle(document.getElementById("su-note")).color'), 'note in the warning colour');
  }],
  ['noSpace', '', async (t) => {
    await t.expect((async () => (await suNote(t)) === 'Not enough storage for the update' && (await suBtn(t))?.text === 'Check')(), 'Zu wenig Platz');
  }],
  ['manual', '', async (t) => {
    await t.expect((async () => (await suNote(t)) === 'This update needs a fresh install' && (await suBtn(t)) === null)(), 'format too new: text, no button');
  }]
];

for (const [state, , check] of SU_STATES) {
  await session(`su-${state.replace(/[^a-z0-9]/gi, '-')}`, { ROLLOUT_SIM_SELFUPDATE: state }, async (t) => {
    await t.expect(state === 'ready' ? t.eval('!!document.querySelector(".su-hint")') : noHint(t), state === 'ready' ? 'home page with update button' : 'home page without update button');
    await t.expect(t.eval('document.querySelectorAll("#view .cards .btn.primary").length === 2'), 'home page: one primary button per card');
    await t.click('Settings');
    await t.expect(t.waitFor('Download updates automatically'), 'Einstellungen');
    await t.expect(t.has(`Rollout ${ownVersion()}`), 'Zeile „Rollout <Version>“');
    await check(t);
    await t.expect(t.eval('document.documentElement.scrollWidth <= window.innerWidth'), 'no horizontal scrolling');
    await t.shot('settings');
  });
}

// Button in the header: visible when "ready" (not busy) and when "update available" with auto_update off.
await session('su-button-ready', { ROLLOUT_SIM_SELFUPDATE: 'ready' }, async (t) => {
  await t.expect(t.eval('!!document.querySelector(".su-hint")'), 'Ready: "Update Rollout" button in the header');
  await t.expect(t.eval('document.querySelector(".su-hint").getAttribute("aria-label") === "Update Rollout" && document.querySelector(".su-hint").title === "Update Rollout"'), 'button has aria-label and title');
  await t.expect(t.eval('(() => { const b = document.querySelector(".su-hint"); return b.nextElementSibling.textContent.includes("Bluetooth"); })()'), 'button sits left of "Bluetooth"');
  await t.expect(t.eval('!!document.querySelector(".su-hint .hintdot") && !document.querySelector(".su-hint .live")'), 'dot without pulse');
  await t.shot('1-start');
  // Real clicks focus the button, the debug click does not: focus it here first so the focus return can be checked.
  const openHint = () => t.eval('(() => { const b = document.querySelector(".su-hint"); b.focus(); b.click(); return true; })()');
  await openHint();
  await t.expect(t.waitFor('Restart Rollout?'), 'Klick: Dialog „Restart Rollout?“');
  await t.expect(t.has('Version 1.3.0 is ready. Restarting takes only a few seconds.'), 'Dialogtext');
  await t.expect((async () => (await t.focus()) === 'Restart now')(), 'focus on "Restart now" (primary button)');
  await t.shot('2-dialog');
  await t.click('Later');
  await t.expect((async () => { await sleep(400); return !(await t.has('Restart Rollout?')); })(), '"Later" closes the dialog');
  await t.expect(t.eval('!!document.querySelector(".su-hint")'), 'button stays after "Later"');
  await openHint();
  await t.waitFor('Restart Rollout?');
  await t.eval('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true');
  await t.expect((async () => { await sleep(400); return !(await t.has('Restart Rollout?')); })(), 'Esc closes the dialog');
  await t.expect((async () => (await t.focus()) === 'Update Rollout')(), 'focus back on the trigger');
  await t.click('Update Rollout');
  await t.waitFor('Restart Rollout?');
  await t.click('Restart now');
  await t.expect(t.waitUntil(async () => (await t.snapshot()).selfUpdate.version === '1.3.0'), 'restart command arrives in the main process (fake)');
});

await session('su-button-auto-off', { ROLLOUT_SIM_SELFUPDATE: 'available' }, async (t) => {
  await t.expect(t.eval('!!document.querySelector(".su-hint")'), 'Update available and auto_update off: button visible');
  await t.click('Update Rollout');
  await t.expect(t.waitFor('Download updates automatically'), 'click opens the settings');
}, { config: 'auto_update = false\n' });

await session('su-button-auto-on', { ROLLOUT_SIM_SELFUPDATE: 'available' }, async (t) => {
  await t.expect(noHint(t), 'Update available, auto_update on: no button');
});

// S2: belegt
await session('s2-busy', { ROLLOUT_SIM_SELFUPDATE: 'ready,blocked' }, async (t) => {
  await t.expect(noHint(t), 'S2 Busy: hint in the header gone');
  await t.click('Settings');
  await t.expect(t.waitFor('Applied the next time Rollout starts'), 'S2 Settings: "Applied the next time Rollout starts"');
  await t.expect((async () => (await suBtn(t))?.disabled === true)(), 'S2 Neustart gesperrt');
  await t.expect(t.eval('!document.querySelector(".modalbg")'), 'S2 no dialog');
});

// S3: Rollback-Hinweis einmalig
await session('s3-rollback-notice', { ROLLOUT_SIM_SELFUPDATE: 'current,notice=1.3.0' }, async (t) => {
  await t.expect(t.waitFor('Update undone'), 'S3 notice appears on the home page');
  await t.expect(t.has("Version 1.3.0 wouldn't start. Rollout keeps using the previous version."), 'S3 text with version');
  await t.expect((async () => (await t.focus()) === 'OK')(), 'S3 focus on "OK" (only primary button)');
  await t.expect(t.eval('document.querySelectorAll(".modal .btn").length === 1'), 'S3 only one button');
  await t.shot('1-notice');
  await t.click('OK');
  await t.expect((async () => { await sleep(500); return !(await t.has('Update undone')); })(), 'S3 gone after "OK"');
  await t.click('Settings');
  await t.click('Back');
  await t.expect((async () => { await sleep(400); return !(await t.has('Update undone')); })(), 'S3 does not appear again');
});

await session('s3-rollback-notice-esc', { ROLLOUT_SIM_SELFUPDATE: 'current,notice=1.3.0' }, async (t) => {
  await t.waitFor('Update undone');
  await t.eval('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true');
  await t.expect((async () => { await sleep(500); return !(await t.has('Update undone')); })(), 'S3 Esc acknowledges the notice');
});

// Advanced, "Launcher" tab: channel and previous version
await session('su-launcher', { ROLLOUT_SIM_SELFUPDATE: 'current,previous=1.1.0' }, async (t) => {
  await t.click('Settings');
  await t.click('Advanced');
  await t.click('Open anyway');
  await t.click('Launcher');
  await t.expect(t.waitFor('Previous version'), 'Reiter Launcher: Zeile „Previous version“');
  await t.expect(t.has('1.1.0'), 'extra line names the version');
  await t.expect(t.eval('document.getElementById("ch").value === "stable"'), 'channel is set to "Stable"');
  await t.expect(t.eval('document.querySelector("[data-act=resetAll]").disabled'), '"Reset all" disabled without deviation');
  await t.expect(t.setSelect('ch', 'beta'), 'channel set to Beta');
  await t.expect(t.waitUntil(async () => (await t.snapshot()).updateChannel === 'beta'), 'Kanal im Zustand');
  await t.expect(t.eval('!document.querySelector("[data-act=resetAll]").disabled'), 'channel counts as a deviation ("Reset all" enabled)');
  await t.click('Reset all');
  await t.expect(t.waitUntil(async () => (await t.snapshot()).updateChannel === 'stable'), '"Reset all" resets the channel');
  await t.clickSel('[data-act=prevAsk]');
  await t.expect(t.waitFor('Start version 1.1.0?'), 'Dialog „Start version 1.1.0?“');
  await t.expect(t.has(`Rollout restarts and skips version ${ownVersion()}.`), 'dialog text names the running version');
  await t.expect((async () => (await t.focus()) === 'Cancel')(), 'primary button is "Cancel"');
  await t.shot('1-previous');
  await t.click('Cancel');
  await t.expect((async () => { await sleep(400); return !(await t.has('Start version 1.1.0?')); })(), 'Cancel closes the dialog');
  await t.clickSel('[data-act=prevAsk]');
  await t.waitFor('Start version');
  await t.clickSel('[data-act=prevNow]');
  await t.expect(t.waitUntil(async () => (await t.snapshot()).selfUpdate.version === '1.1.0'), 'Start triggers the switch (fake)');
});

await session('su-launcher-blocked', { ROLLOUT_SIM_SELFUPDATE: 'current,previous=1.1.0,blocked' }, async (t) => {
  await t.click('Settings');
  await t.click('Advanced');
  await t.click('Open anyway');
  await t.click('Launcher');
  await t.expect(t.eval('document.querySelector("[data-act=prevAsk]").disabled'), 'Busy: "Start" for the previous version disabled');
});

// S4: screenshots and layout at 1024 × 640 and 1280 × 800 in pl, pt, fr, de
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
      await t.expect(Promise.resolve(wrap.n === 4 && wrap.sameRow && wrap.fits && wrap.scroll), `S4 ${lang} ${w}×${h}: header without wrapping (${JSON.stringify(wrap)})`);
      await t.expect(Promise.resolve(wrap.text === (w >= 1180)), `S4 ${lang} ${w}×${h}: ${w >= 1180 ? 'button with text' : 'button with icon only'}`);
      await t.shot(`start-${w}x${h}`);
    }
    await t.click(await t.eval('document.querySelector(".top .btn:nth-last-child(2)").textContent.trim()'));
    for (const [w, h] of [[1280, 800], [1024, 640]]) {
      await t.viewport(w, h);
      await sleep(400);
      await t.expect(t.eval('document.documentElement.scrollWidth <= window.innerWidth'), `S4 ${lang} ${w}×${h}: settings without horizontal scrolling`);
      await t.shot(`settings-${w}x${h}`);
    }
  });
}

// ---------- Launcher update: full run with real Electron and watcher (S5 to S8) ----------
const electronDir = process.env.ROLLOUT_ELECTRON_DIR || (fs.existsSync(path.join('node_modules/electron/dist/electron')) ? path.resolve('node_modules/electron/dist') : null);
if (!electronDir) console.log('s5-s8\n  – skipped: ROLLOUT_ELECTRON_DIR does not point to an Electron directory');
else if (!fs.existsSync('dist/main/main.js')) console.log('s5-s8\n  – skipped: dist/ is missing, run npm run build first');
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

  // S5 and S8: version N sees N+1, downloads, button, restart. Then "Previous version".
  {
    const { home, feedDir, key } = fresh('s5');
    publish({ feedDir, key, version: N1, runtime: keepRuntime(ev) });
    await withHome('s5-durchlauf', home, feedDir, key, { env: {}, config: 'auto_update = false\n', shots: process.env.ROLLOUT_SHOTS }, async (t) => {
      await t.expect(t.waitUntil(async () => !(await noHint(t))), `S5 ${N} sieht ${N1}: Knopf „Update Rollout“ erscheint`);
      await t.click('Update Rollout');
      await t.expect(t.waitFor(`Version ${N1} · `), 'S5 settings name the new version');
      await t.shot('1-available');
      await t.click('Download');
      await t.expect(t.waitFor(`Version ${N1} is ready`, 30000), 'S5 downloaded, "is ready"');
      await t.expect(Promise.resolve(stateFile(home, 'pending') === `${N1}\n` && linkOf(home, 'current') === N), 'S5 pending exists, current is still N');
      await t.shot('2-ready');
      await t.click('Restart now');
      await t.reattach(60000);
      await t.click('Settings');
      await t.expect(t.waitFor(`Rollout ${N1}`), `S5 Einstellungen zeigen ${N1}`);
      await t.expect(t.waitUntil(() => stateFile(home, 'trial') === null, 20000), 'S5 state/trial weg (Probe bestanden)');
      await t.expect(Promise.resolve(linkOf(home, 'previous') === N && linkOf(home, 'current') === N1 && stateFile(home, 'pending') === null), `S5 previous points to ${N}`);
      await t.expect(t.waitFor('Up to date'), 'S5 „Up to date“');
      await t.shot('3-new');

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
      await t.expect(t.waitFor(`Rollout ${N}`), `S8 running on ${N} again`);
      await t.expect(Promise.resolve((stateFile(home, 'bad') ?? '').split('\n').includes(N1) && linkOf(home, 'current') === N), `S8 ${N1} is listed in bad`);
      await t.click('Check');
      await t.expect(t.waitFor('Up to date', 15000), `S8 ${N1} is not offered again`);
      await t.expect(Promise.resolve(stateFile(home, 'pending') === null), 'S8 no pending');
    });
  }

  // S6: release with a throw in main.js
  {
    const { home, feedDir, key } = fresh('s6');
    publish({ feedDir, key, version: N1, runtime: keepRuntime(ev), mutate: (stage) => {
      const file = path.join(stage, 'dist/main/main.js');
      fs.writeFileSync(file, `throw new Error('absichtlich');\n${fs.readFileSync(file, 'utf8')}`);
    } });
    await withHome('s6-fehlstart', home, feedDir, key, { env: {}, shots: process.env.ROLLOUT_SHOTS }, async (t) => {
      await t.expect(stageUpdate(t).then((problem) => problem === null), `S6 ${N1} (faulty) downloaded and ready`);
      await t.eval('void window.rollout.restartForUpdate(); true');
      await t.reattach(120000);
      await t.expect(t.waitUntil(async () => (await t.snapshot()).selfUpdate.version === N), `S6 after two attempts ${N} runs again`);
      await t.expect(t.waitFor('Update undone', 10000), 'S6 Hinweis „Update undone“ erscheint');
      await t.expect(Promise.resolve((stateFile(home, 'bad') ?? '').split('\n').includes(N1) && linkOf(home, 'current') === N && stateFile(home, 'trial') === null), `S6 ${N1} in bad, current ${N}, trial weg`);
      await t.shot('1-notice');
      await t.click('OK');
      await t.expect((async () => { await sleep(500); return !(await t.has('Update undone')) && stateFile(home, 'notice') === null; })(), 'S6 notice gone after OK, notice file deleted');
      await t.click('Settings');
      await t.click('Check');
      await t.expect(t.waitFor('Up to date', 15000), 'S6 the version is not downloaded again');
      await t.expect(Promise.resolve(stateFile(home, 'pending') === null), 'S6 no pending');
      const log = stateFile(home, 'boot.log') ?? '';
      await t.expect(Promise.resolve(/back to/.test(log)), 'S6 boot.log mentions the rollback');
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
      await t.expect(Promise.resolve(stateFile(home, 'pending') === null), 'S7 tampered manifest: no pending');
      await t.expect(t.has('Ride'), 'S7 app usable (card with "Ride"), no error screen');
      await t.expect(noHint(t), 'S7 no update button');
      await t.click('Settings');
      await t.click('Check');
      await t.expect(t.waitFor('Update failed its check', 10000), 'S7 by hand: "Update failed its check"');
      await t.shot('1-tampered');
    });
  }
  {
    const { home, feedDir, key } = fresh('s7b');
    fs.mkdirSync(feedDir, { recursive: true });
    await withHome('s7-offline', home, feedDir, key, { env: {}, shots: process.env.ROLLOUT_SHOTS }, async (t) => {
      await sleep(2500);
      await t.expect(Promise.resolve(stateFile(home, 'pending') === null), 'S7 empty directory: no pending');
      await t.expect(t.has('Ride'), 'S7 App bedienbar');
      await t.click('Settings');
      await t.click('Check');
      await t.expect(t.waitFor("Couldn't check right now", 10000), 'S7 by hand: "Couldn\'t check right now"');
    });
  }

  // A2: Electron swap. 45.2.2 is a wrapper around the existing Electron here; it answers the trial run's version query and otherwise
  // forwards to it: what is checked is download, trial run, swap, rollback and cleanup, not Chromium 45.2.2 itself.
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

    // Successful swap, then a second update: the old Electron directory stays as long as previous needs it and disappears only afterwards.
    {
      const { home, feedDir, key } = fresh('a2');
      const N2 = bumpVersion(N1);
      publish({ feedDir, key, version: N1, runtime: { ...runtimeArchive(feedDir, N1), min: wrapVersion } });
      await withHome('a2-electron-tausch', home, feedDir, key, { env: {} }, async (t) => {
        await t.expect(stageUpdate(t).then((problem) => problem === null), `A2 ${N1} with Electron ${wrapVersion} downloaded and ready`);
        await t.expect(Promise.resolve(exists(home, `electron/${wrapVersion}/electron`) && fs.readFileSync(path.join(home, 'versions', N1, 'runtime'), 'utf8') === `${wrapVersion}\n`), 'A2 new Electron sits next to the old one, runtime names it');
        await t.expect(Promise.resolve(exists(home, `electron/${ev}/electron`)), 'A2 altes Electron bleibt liegen');
        await t.eval('void window.rollout.restartForUpdate(); true');
        await t.reattach(60000);
        await t.expect(t.waitUntil(async () => (await t.snapshot()).selfUpdate.version === N1), `A2 running on ${N1}`);
        await t.expect(t.waitUntil(() => stateFile(home, 'trial') === null, 20000), 'A2 trial with the new Electron passed');
        await sleep(6000);
        await t.expect(Promise.resolve(exists(home, `electron/${ev}/electron`) && exists(home, `versions/${N}`)), 'A2 cleanup keeps N and its Electron while previous needs them');
        publish({ feedDir, key, version: N2, runtime: keepRuntime(wrapVersion) });
        await t.expect(stageUpdate(t).then((problem) => problem === null), `A2 ${N2} bereit`);
        await t.eval('void window.rollout.restartForUpdate(); true');
        await t.reattach(60000);
        await t.expect(t.waitUntil(async () => (await t.snapshot()).selfUpdate.version === N2), `A2 running on ${N2}`);
        await t.expect(t.waitUntil(() => !exists(home, `electron/${ev}`) && !exists(home, `versions/${N}`), 30000), 'A2 afterwards cleanup removes the old Electron directory and the old version');
        await t.expect(Promise.resolve(exists(home, `electron/${wrapVersion}/electron`) && linkOf(home, 'previous') === N1), 'A2 current and previous keep their Electron');
      });
    }

    // Failed start with new Electron: rollback switches Electron back too.
    {
      const { home, feedDir, key } = fresh('a2r');
      publish({ feedDir, key, version: N1, runtime: { ...runtimeArchive(feedDir, N1), min: wrapVersion }, mutate: toThrow });
      await withHome('a2-electron-rollback', home, feedDir, key, { env: {} }, async (t) => {
        await t.expect(stageUpdate(t).then((problem) => problem === null), `A2 ${N1} (faulty, Electron ${wrapVersion}) ready`);
        await t.eval('void window.rollout.restartForUpdate(); true');
        await t.reattach(120000);
        await t.expect(t.waitUntil(async () => (await t.snapshot()).selfUpdate.version === N), `A2 rollback: ${N} runs again`);
        await t.expect(Promise.resolve(fs.readFileSync(path.join(home, 'versions', N, 'runtime'), 'utf8') === `${ev}\n` && linkOf(home, 'current') === N), 'A2 rollback: old version with old Electron');
        await t.expect(t.waitUntil(() => !exists(home, `electron/${wrapVersion}`) && !exists(home, `versions/${N1}`), 30000), 'A2 cleanup removes the unproven Electron and the version only afterwards');
      });
    }
  }

  // A3: back to an older Electron major version (45 → 44) with the same profile. Needs ROLLOUT_ELECTRON_OLD (directory with Electron 44).
  if (process.env.ROLLOUT_ELECTRON_OLD) {
    const profile = path.join(tmp, 'a3-profile');
    const cfg = path.join(tmp, 'a3-config');
    const shared = { userData: profile, configHome: cfg, home: path.join(tmp, 'a3-home') };
    await session('a3-electron-45', {}, async (t) => {
      await t.click('Settings');
      await t.click('Advanced');
      await t.click('Open anyway');
      await t.click('Launcher');
      await t.expect(t.setSelect('ch', 'beta'), 'A3 with Electron 45: channel set to Beta');
      await t.expect(t.waitUntil(async () => (await t.snapshot()).updateChannel === 'beta'), 'A3 Kanal im Zustand');
      await sleep(1500);
    }, { ...shared, electron: path.join(electronDir, 'electron') });
    await session('a3-electron-44', {}, async (t) => {
      await t.expect(t.waitUntil(async () => (await t.snapshot())?.updateChannel === 'beta'), 'A3 with Electron 44, same profile: window opens, setting persists');
      await t.expect(t.eval('navigator.userAgent.includes("Electron/44.")'), 'A3 really runs on Electron 44');
    }, { ...shared, electron: path.join(process.env.ROLLOUT_ELECTRON_OLD, 'electron') });
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

// In Gaming Mode test windows live in Gamescope, where the dimensions are not comparable.
const inGamingMode = spawnSync('pgrep', ['-f', 'gamescope-session']).status === 0;
if (inGamingMode) console.log('fullscreen-from-steam\n  – skipped: Gaming Mode is running');
else {
await session('fullscreen-from-steam', { SteamGameId: '1' }, async (t) => {
  await t.expect(t.eval('window.innerWidth === screen.width && window.innerHeight === screen.height'), 'start from Steam in fullscreen');
  await t.shot('1-fullscreen');
});
}

const evalFocusId = (t) => t.eval('document.activeElement && document.activeElement.id');

await session('appearance', { ROLLOUT_SIM_LANG: 'en' }, async (t) => {
  const isLight = () => t.eval('document.getElementById("root").classList.contains("light")');
  await t.click('Settings');
  await t.expect(t.clickSel('#theme'), '"Appearance" picker opened');
  await t.expect(t.waitFor('Light'), 'list with Automatic, Dark, Light');
  await t.click('Light');
  await t.expect((async () => { await sleep(500); return await isLight(); })(), 'Light is applied immediately');
  await t.shot('1-light-settings');
  await t.expect(t.clickSel('#theme'), 'picker opened again');
  await t.click('Dark');
  await t.expect((async () => { await sleep(500); return !(await isLight()); })(), 'Dark is applied');
  await t.expect(t.clickSel('#theme'), 'picker opened a third time');
  await t.click('Automatic');
  await t.expect((async () => { await sleep(500); return typeof (await isLight()) === 'boolean'; })(), 'Automatic follows the system');
});

await session('touch-then-keys', { ROLLOUT_SIM_LANG: 'en' }, async (t) => {
  const nav = () => t.eval('document.documentElement.classList.contains("nav")');
  await t.eval('document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); document.activeElement && document.activeElement.blur(); true');
  await t.expect((async () => !(await nav()))(), 'after touch the focus ring is off');
  await t.eval('window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); true');
  await t.expect((async () => (await nav()) && (await t.eval('document.activeElement !== document.body')))(), 'first key after touch finds the focus again and shows the ring');
  await t.eval('document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); true');
  await t.expect((async () => !(await nav()))(), 'touch hides the ring again');
});

await session('light-start', { ROLLOUT_SIM_THEME: 'light' }, async (t) => {
  await t.expect(t.eval('document.getElementById("root").classList.contains("light")'), 'Start im hellen Design');
  await t.shot('1-light-start');
  await t.click('Settings');
  await t.click('Advanced');
  await t.click('Open anyway');
  await t.click('Bluetooth');
  await t.expect(t.clickSel('#ad'), 'adapter list opened');
  await t.expect(t.waitFor('hci1 · USB'), 'adapter list shows all adapters');
  await t.shot('2-light-adapter-list');
  await t.expect(t.eval('(() => { const p = document.querySelector(".picker"); return p.scrollWidth <= p.clientWidth + 1; })()'), 'list without sideways clipping');
});

// Manual only with ROLLOUT_REAL_BT=1: scans with the real adapter and shows what is broadcasting nearby.
if (process.env.ROLLOUT_REAL_BT === '1') {
  await session('bluetooth-real', { ROLLOUT_BT: 'real' }, async (t) => {
    await t.clickSel('button[data-act=appMenu][data-arg=mywhoosh]');
    await t.click('Bluetooth');
    await t.waitFor('Sensors nearby');
    await sleep(Number(process.env.ROLLOUT_REAL_BT_WAIT || 20000));
    console.log((await t.text()).split('\n').filter(Boolean).join(' | '));
    await t.shot('1-bluetooth-real');
  });
}

await session('quit', {}, async (t) => {
  await t.expect(t.click('Quit Rollout'), 'quit button next to the settings');
  await t.expect(t.waitFor('Quit Rollout?'), 'confirmation before quitting');
  await t.expect(t.has('Running installs and updates keep going.'), 'Hinweistext');
  await t.expect((async () => (await t.focus()) === 'Cancel')(), 'focus on "Cancel" (primary button)');
  await t.shot('1-quit-dialog');
  await t.click('Cancel');
  await t.expect((async () => { await sleep(400); return !(await t.has('Quit Rollout?')); })(), 'Cancel closes the dialog');
  await t.expect((async () => (await t.exited(1500)) === false)(), 'app keeps running after "Cancel"');
  await t.click('Quit Rollout');
  await t.waitFor('Quit Rollout?');
  await Promise.race([t.click('Quit'), t.exited(8000)]);
  await t.expect(t.exited(8000), 'app exits after "Quit"');
});

await session('size', {}, async (t) => {
  const width = () => t.eval('window.innerWidth');
  const before = await width();
  await t.click('Settings');
  await t.expect(t.clickSel('#scale'), '"Interface size" picker opened');
  await t.expect(t.waitFor('125 %'), 'list with Automatic and the percentages');
  await t.click('125 %');
  await sleep(700);
  const after = await width();
  await t.expect(Promise.resolve(Math.abs(before / after - 1.25) < 0.03), `UI enlarged by 125 % (${before} → ${after} px width)`);
  await t.shot('1-size');
});

const SPRACHEN = { es: 'Listo', fr: 'Prêt', it: 'Pronto', pt: 'Pronto', nl: 'Klaar', pl: 'Gotowe' };
for (const [code, word] of Object.entries(SPRACHEN)) {
  await session(`sprache-${code}`, { ROLLOUT_SIM_LANG: code }, async (t) => {
    await t.expect(t.has(word), `Startseite in „${code}“`);
  });
}

await session('switch-language', {}, async (t) => {
  await t.click('Settings');
  await t.expect(t.waitFor('Download updates automatically'), 'settings in English');
  await t.expect(t.clickSel('#lang'), 'language list opened');
  await t.expect(t.waitFor('Français'), 'own list with all languages');
  await t.expect((async () => (await t.focus()) === 'English')(), 'focus on the selected language');
  await t.shot('1-language-list');
  await t.expect(t.click('Français'), 'language selected');
  await t.expect(t.waitFor('Télécharger les mises à jour automatiquement'), 'UI switches language immediately');
  await t.expect((async () => { await sleep(300); return (await evalFocusId(t)) === 'lang'; })(), 'focus back on the picker');
});

failuresExit();
