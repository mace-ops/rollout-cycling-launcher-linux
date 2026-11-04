# Rollout (Oberfläche)

Electron-App mit TypeScript. Sie zeigt die Bildschirme aus `docs/design.md` und spricht über `src/shared/api.ts` mit dem Hauptprozess.
Der Hauptprozess nutzt noch `src/main/sim.ts`, eine Simulation ohne echte Installation. Die echten Adapter ersetzen nur diese Datei.
Das Launcher-Update (`src/main/selfupdate.ts`) ist davon unabhängig und echt, siehe unten.

## Befehle

```sh
npm install
npm run build        # bündelt nach dist/
npm start            # baut und startet
npm run test:unit    # VDF, Steam, Config, Bluetooth, Zoom, Selbst-Update (U1 bis U9), Wächter (W1 bis W12), Release-Werkzeug
npm test             # Typprüfung, Unit-Tests, Build, Klicktest (braucht eine Bildschirmsitzung)
```

Der Klicktest `test/smoke.mjs` startet die App je Szenario neu, geht alle Ansichten durch und legt mit `ROLLOUT_SHOTS=<Ordner>` Screenshots ab.
Auf Systemen ohne `electron` im Pfad: `ELECTRON_BIN=<Pfad> ELECTRON_RUN_AS_NODE=1 <Pfad> test/smoke.mjs`.
Rahmen, Attrappen und Wegwerf-Ordner stehen in `test/harness.mjs` und werden nicht überschreibbar erzwungen (Steam-Attrappe, Bluetooth-Attrappe, `ROLLOUT_SELFUPDATE=fake`, Wegwerf-`ROLLOUT_HOME` und `ROLLOUT_CONFIG_HOME`).
Die Szenarien S1 bis S4 (Oberfläche des Launcher-Updates) laufen mit `ROLLOUT_SIM_SELFUPDATE`, S5 bis S8 (Durchlauf mit echtem Electron und dem Wächter, Wegwerf-Installation) mit
`ROLLOUT_ELECTRON_DIR=<Ordner mit der Datei electron>` und gebautem `dist/`; sonst werden sie übersprungen. `ROLLOUT_ELECTRON_OLD=<Ordner mit Electron 44>` schaltet A3 (Zurück auf eine ältere Hauptversion mit demselben Profil) zu. `ROLLOUT_ONLY=<Präfix>` wählt Szenarien. `rollout-run` hat eigene Tests (`test/run.test.mjs`, laufen mit `npm run test:unit`). Am Ally dafür `DISPLAY=:0` und ein `TMPDIR` auf btrfs setzen.

## Fester Pfad und Steam

`scripts/install.sh [Electron-Ordner]` legt nach `npm run build` alles unter `~/.local/share/rollout` ab (`$ROLLOUT_HOME` überschreibt das), Aufbau nach Konzept 4.3:

```text
bin/rollout            Starter und Wächter (scripts/bin-rollout.sh), Steam-Ziel, ändert sich im Pfad nie
bin/rollout-run        Spielstarter (scripts/bin-rollout-run.sh): Umgebung bereinigen, Bildschirm wachhalten, state/run.pid; Upstream-Anbindung folgt mit den Adaptern
current -> versions/<v>   previous -> versions/<v>
versions/<v>/          package.json, dist/, bootstrap/rollout, runtime (Name des Electron-Ordners)
electron/<v>/          Electron
staging/ state/        Laden und Entpacken, Wächter-Zustand (lock, pending, trial, healthy, bad, notice, boot.log, check.json)
icon.png
```

Ein alter Aufbau (`app/dist`, `app/electron`) zieht beim nächsten Lauf um und behält sein Electron. Ohne Argument bleibt ein vorhandenes Electron, sonst kommt `node_modules/electron/dist` zum Einsatz,
mit `REPLACE_ELECTRON=1` und Argument oder `ELECTRON_DIR` wird ein anderes genommen. Rollout vorher beenden.

## Launcher-Update

Konzept 6.1 bis 6.12, Oberfläche Design 10.12. Der Wächter `bin/rollout` bleibt als Elternprozess von Electron (`ROLLOUT_SUPERVISED=1`), tauscht `current` per `rename`, startet die neue Version zur Probe
und schaltet nach zwei Fehlschlägen auf `previous` zurück. Ohne Wächter (`npm start`) gibt es keine Prüfung und keine Zeile mit Knopf in den Einstellungen.
`src/main/selfupdate.ts` prüft ein signiertes Manifest (Ed25519, `node:crypto`), lädt App- und bei Bedarf Electron-Archiv, prüft Größe und SHA-256, legt die Version bereit und schreibt zuletzt `state/pending`.
Das Netz steckt hinter `Feed` (`selfupdate-net.ts`, nur im Hauptprozess), die Attrappen stehen in `selfupdate-fake.ts`. Pfade im Hauptprozess nur über `__dirname`, nie über `app.getAppPath()` (zeigt auf den Symlink).

**Schlüssel:** `src/main/selfupdate-keys.ts` ist leer. Solange kein öffentlicher Schlüssel eingetragen ist, prüft der Client gar nicht und lehnt alles ab. Der echte Schlüssel entsteht erst bei der Veröffentlichung (Konzept 6.4, Schritt 7).

**Release bauen** (nur lokal, kein Upload):

```sh
npm test
node scripts/release.mjs pack --runtime <Electron-Ordner>        # oder --runtime-from <früheres rollout-update.json>
node scripts/release.mjs check --electron <Electron-Ordner> [--previous <rollout-<v>-app.tar.gz>]
```

`pack` schreibt Archive und das signierte `rollout-update.json` nach `release-out/` (per `.gitignore` ausgenommen) und fragt nach der Passphrase des Schlüssels
(`--key`, sonst `~/.config/rollout-release/rollout-update-1.pem`; `ROLLOUT_RELEASE_PASSPHRASE` ersetzt die Frage). `check` ist die Release-Probe (Konzept 6.12): vorheriges Release auf den Kandidaten,
dann den Kandidaten auf eine künstliche Version +1, mit Testschlüssel und echtem Electron. Tag, Entwurf, Upload und Veröffentlichung folgen von Hand nach Konzept 6.3.

**Einstellungen:** `update_channel = "stable"` oder `"beta"` in der `config.toml` (nur Abweichungen), bedient unter Erweitert, Reiter „Launcher“. „Updates automatisch laden“ gilt auch für den Launcher.

Rollout startet im Vollbild, wenn Steam es startet oder der Gaming Mode läuft. `--fullscreen` erzwingt das, `--windowed` verhindert es, `F11` schaltet um.

Oben rechts beendet der runde Knopf neben „Einstellungen“ die App, nach einer Rückfrage.

In den Einstellungen legt der Schalter „Rollout in Steam“ einen Nicht-Steam-Eintrag auf `bin/rollout` an oder entfernt ihn (`src/main/steam.ts`, `vdf.ts`).
Ablauf: Läuft Steam, fragt Rollout „Steam muss kurz neu starten“, schließt Steam, schreibt `shortcuts.vdf` und startet Steam wieder.
Geschrieben wird mit Sicherung (`shortcuts.vdf.rollout-backup-*`, die letzten drei bleiben), Prüfung und atomarem Umbenennen. Fremde Einträge bleiben byte-genau erhalten.
Dazu erzeugt Rollout die Bilder für die Bibliothek (Hochformat, Breitformat, Hintergrund mit dem MyWhoosh-Foto, Logo) in `config/grid`, benannt nach der AppID (`src/main/artwork.ts`). Steam zeigt sie nach seinem nächsten Start.
Nur natives Steam im Desktop-Modus. Flatpak, Snap und der Gaming Mode melden „nicht verfügbar“.

## Simulierte Zustände

| Variable | Wirkung |
| --- | --- |
| `ROLLOUT_SIM_STATE=fresh` | keine App installiert |
| `ROLLOUT_SIM_UPDATE=1` | für installierte Apps ist ein Update da |
| `ROLLOUT_SIM_CRASH=1` | Spiel beendet sich nach dem Start |
| `ROLLOUT_SIM_LANG=de` | Sprache fest wählen, sonst die gespeicherte oder die Systemsprache |
| `ROLLOUT_SIM_THEME=light` | Aussehen fest wählen (`dark` oder `light`) |
| `ROLLOUT_SIM_SCALE=125` | Größe fest wählen |
| `ROLLOUT_CONFIG_HOME=<Ordner>` | Ort der `config.toml`, im Test ein Wegwerf-Ordner |
| `ROLLOUT_BT=fake` | Bluetooth-Attrappe statt `bluetoothctl`; `ROLLOUT_SIM_BT=problem` lässt den Adapter ausfallen |
| `ROLLOUT_SIM_STEAM=fake` | Steam-Zugriff durch eine Attrappe ersetzen. Der Klicktest erzwingt das, damit nie echte Steam-Dateien geändert werden |
| `ROLLOUT_SIM_STEAM_RUNNING=1` | die Attrappe tut so, als liefe Steam |
| `ROLLOUT_SIM_SELFUPDATE=<Zustand>[,blocked][,fail][,previous=<v>][,notice=<v>][,next=<v>][,mb=<n>]` | Launcher-Update fest wählen (`current`, `checking`, `checkFailed`, `available`, `downloading`, `ready`, `invalid`, `noSpace`, `manual`, `none`), ohne Dateien und ohne Neustart |
| `ROLLOUT_SELFUPDATE=fake` | ersetzt das Netz durch `ROLLOUT_SELFUPDATE_DIR` (`rollout-update.json`, `rollout-update-beta.json`, Archive nach Dateiname) und nimmt den öffentlichen Schlüssel (32 Byte, Base64) aus `ROLLOUT_SELFUPDATE_KEY`. Gilt nur mit gesetztem `ROLLOUT_HOME`, sonst bricht die App ab. Verkürzt die Zeiten (erste Prüfung 0,3 s, Gesund-Meldung 1 s). `ROLLOUT_SELFUPDATE_DELAY_MS` bremst das Laden |
| `ROLLOUT_HOME=<Ordner>` | Ort der Installation (Zustand des Selbst-Updates, Steam-Ziel), im Test ein Wegwerf-Ordner |
| `ROLLOUT_BOOT_TIMEOUT`, `ROLLOUT_BOOT_GRACE` | Zeitlimit der Probe (60 s) und Frist zwischen TERM und KILL (5 s) im Wächter, im Test verkürzt |

## Sprachen

Englisch ist die Quellsprache (`src/renderer/locales/en.ts`). Vorhanden: Englisch, Deutsch, Spanisch, Französisch, Italienisch, Portugiesisch, Niederländisch, Polnisch. Japanisch und Chinesisch sind bewusst nicht dabei. Eine weitere Sprache ist eine Datei im selben Ordner, die den Typ `Messages` erfüllt,
plus ein Eintrag in `src/renderer/i18n.ts`. Fehlt ein Schlüssel, meldet die Typprüfung das. Die Sprache folgt dem System und lässt sich in den Einstellungen ändern.

## Einstellungen

Sprache, Aussehen (Automatisch, Dunkel, Hell), Größe der Oberfläche und „Updates automatisch laden“ werden in `~/.config/rollout/config.toml` gespeichert, und zwar nur Abweichungen von den Vorgaben (`src/main/config.ts`, `ROLLOUT_CONFIG_HOME` verlegt den Ordner).

Die Oberfläche ist für 1280 × 800 entworfen. „Automatisch“ vergrößert sie mit dem Fenster (ein Ally mit 1920 × 1080 zeigt 135 %), nie unter 100 %. Handwerte reichen bis 175 % und werden auf das begrenzt, was noch in 1024 × 640 passt (`src/main/zoom.ts`).

## Bluetooth

Die Suche nutzt `bluetoothctl` (`src/main/bluetooth.ts`) und zeigt Trainer (FTMS oder Cycling Power) und Herzfrequenz-Gurte, die gerade senden. Es wird nichts gekoppelt.
`ROLLOUT_BT=fake` ersetzt sie durch eine Attrappe, der Klicktest erzwingt das. Von Hand mit echtem Adapter: `ROLLOUT_REAL_BT=1 ROLLOUT_ONLY=bluetooth-echt` beim Klicktest.

## Bedienung

Auswahlfelder öffnen eine eigene Liste in der App statt des nativen Menüs, weil das Controller und Touch im Gaming Mode nicht bedienen können.

Maus, Touch, Tastatur und Controller: Pfeile, Steuerkreuz und linker Stick wechseln den Fokus, Enter oder A löst aus, Esc oder B geht zurück, der rechte Stick scrollt.
Im Desktop-Modus unter Steam erreicht das Gamepad Chromium nicht (Gate G4, E1), im Gaming Mode funktioniert es.

## Marke

`src/renderer/assets/brand/`: `logo.svg`, `logo-currentcolor.svg`, `wordmark.svg` (Text in Archivo, die Schrift muss geladen sein), `logo.png`.
