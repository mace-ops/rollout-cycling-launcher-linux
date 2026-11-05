// Captures for the website and README: 1600 × 1000 (16:10, later scaled down to 1280 × 800), one language per run (ROLLOUT_SIM_LANG), directory via ROLLOUT_SHOTS.
// Usage (after `npm run build`): ROLLOUT_SIM_LANG=de ROLLOUT_SHOTS=../site/shots-raw/de ELECTRON_RUN_AS_NODE=1 npx electron test/shots.mjs
// Files: s1-<name>.png and s2-<name>.png. Names: before-install installing done home pick settings steam advanced light bluetooth starting error.
// Selectors instead of labels so the same flow works in all languages.
import { failuresExit, session, sleep } from './harness.mjs';

const card = (id) => `article[data-tone=${id}] .btn.primary`;
const view = (t) => t.expect(t.waitUntil(async () => (await t.eval('document.getElementById("view").innerText.length')) > 0), 'Ansicht da');
const installed = (t, id) => t.waitUntil(async () => (await t.snapshot()).apps[id].installed, 60000);

// Fresh: install view, Zwift installation, then MyWhoosh too; in the end both apps are ready.
await session('s1', { ROLLOUT_SIM_STATE: 'fresh' }, async (t) => {
  await t.viewport(1600, 1000);
  await view(t);
  await t.clickSel(card('mywhoosh'));
  await t.expect(t.waitUntil(async () => t.eval('!!document.querySelector("[data-act=install]")')), 'MyWhoosh installieren');
  await t.shot('before-install');
  await t.clickSel('button.back');
  await t.expect(t.waitUntil(async () => t.eval(`!!document.querySelector(${JSON.stringify(card('zwift'))})`)), 'overview');
  await t.clickSel(card('zwift'));
  await t.expect(t.waitUntil(async () => t.eval('!!document.querySelector("[data-act=install]")')), 'Zwift installieren');
  await t.clickSel('[data-act=install]');
  await t.expect(t.waitUntil(async () => ((await t.snapshot()).job?.progress ?? 0) >= 45), 'Fortschritt');
  await t.shot('installing', 100);
  await t.expect(t.waitUntil(async () => t.eval('!!document.querySelector(".bigcheck")'), 60000), 'Zwift fertig');
  await t.shot('done');
  await t.clickSel('.center .btn:not(.primary)');
  await t.expect(t.waitUntil(async () => t.eval(`!!document.querySelector(${JSON.stringify(card('mywhoosh'))})`)), 'overview');
  await t.clickSel(card('mywhoosh'));
  await t.expect(t.waitUntil(async () => t.eval('!!document.querySelector("[data-act=install]")')), 'MyWhoosh installieren');
  await t.clickSel('[data-act=install]');
  await t.expect(installed(t, 'mywhoosh'), 'MyWhoosh fertig');
  await t.expect(t.waitUntil(async () => t.eval('!!document.querySelector(".bigcheck")')), 'fertig-Ansicht');
  await t.clickSel('.center .btn:not(.primary)');
  await t.expect(t.waitUntil(async () => (await t.eval('document.querySelectorAll("article.card:not(.off)").length')) === 2), 'beide bereit');
  await sleep(1200);
  await t.shot('home');
  await t.eval(`document.querySelector(${JSON.stringify(card('zwift'))}).focus()`);
  await t.shot('pick', 1500);
  await t.eval('document.activeElement.blur()');
  await t.clickSel('[data-act=go][data-arg=settings]');
  await t.expect(t.waitUntil(async () => t.eval('!!document.getElementById("theme")')), 'Einstellungen');
  await t.shot('settings');
  await t.clickSel('[data-act=advanced]');
  await t.expect(t.waitUntil(async () => t.eval('!!document.querySelector("[data-act=passGate]")')), 'Abfrage');
  await t.clickSel('[data-act=passGate]');
  await t.expect(t.waitUntil(async () => t.eval('!!document.querySelector("[data-act=tab]")')), 'Erweitert');
  await t.shot('advanced');
  await t.clickSel('[data-act=go][data-arg=settings]');
  await sleep(500);
  await t.clickSel('button.back');
  await t.expect(t.waitUntil(async () => t.eval(`!!document.querySelector(${JSON.stringify(card('mywhoosh'))})`)), 'overview');
  // Start of MyWhoosh up to "Starting"
  await t.clickSel(card('mywhoosh'));
  await t.expect(t.waitUntil(async () => (await t.snapshot()).launch?.phase === 'starting', 30000), 'Startphase');
  await t.shot('starting', 150);
});

// Bluetooth: check and error view
await session('s2', { ROLLOUT_SIM_BT: 'problem' }, async (t) => {
  await t.viewport(1600, 1000);
  await view(t);
  await t.clickSel('button[data-act=appMenu][data-arg=mywhoosh]');
  await t.expect(t.waitUntil(async () => t.eval('!!document.querySelector("[data-act=go][data-arg=bluetooth]")')), 'menu');
  await t.clickSel('[data-act=go][data-arg=bluetooth]');
  await t.expect(t.waitUntil(async () => t.eval('!!document.getElementById("scan")')), 'Bluetooth');
  await sleep(1500);
  await t.clickSel('button.back');
  await t.clickSel('button.back');
  await t.expect(t.waitUntil(async () => t.eval(`!!document.querySelector(${JSON.stringify(card('mywhoosh'))})`)), 'overview');
  await t.clickSel(card('mywhoosh'));
  await t.expect(t.waitUntil(async () => (await t.snapshot()).launch?.phase === 'bterror', 40000), 'Fehleransicht');
  await t.shot('error');
});
await session('s3', {}, async (t) => {
  await t.viewport(1600, 1000);
  await view(t);
  await t.clickSel('button[data-act=appMenu][data-arg=mywhoosh]');
  await t.expect(t.waitUntil(async () => t.eval('!!document.querySelector("[data-act=go][data-arg=bluetooth]")')), 'menu');
  await t.clickSel('[data-act=go][data-arg=bluetooth]');
  await t.expect(t.waitUntil(async () => t.eval('document.querySelectorAll(".found").length >= 2'), 20000), 'Sensoren gefunden');
  await t.shot('bluetooth', 1200);
});
// Steam asks before the restart (Steam is running)
await session('s4', { ROLLOUT_SIM_STEAM_RUNNING: '1' }, async (t) => {
  await t.viewport(1600, 1000);
  await view(t);
  await t.clickSel('[data-act=go][data-arg=settings]');
  await t.expect(t.waitUntil(async () => t.eval('!!document.getElementById("theme")')), 'Einstellungen');
  await t.clickSel('[data-act=steam][data-arg=mywhoosh]');
  await t.expect(t.waitUntil(async () => t.eval('!!document.querySelector(".modalbg")')), 'Steam-Dialog');
  await t.shot('steam', 900);
});
// Helles Design (Einstellungen)
await session('s5', { ROLLOUT_SIM_THEME: 'light' }, async (t) => {
  await t.viewport(1600, 1000);
  await view(t);
  await t.clickSel('[data-act=go][data-arg=settings]');
  await t.expect(t.waitUntil(async () => t.eval('!!document.getElementById("theme")')), 'Einstellungen hell');
  await t.shot('light', 900);
});
failuresExit();
