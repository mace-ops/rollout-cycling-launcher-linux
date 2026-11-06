# Rollout (UI)

Electron app written in TypeScript. It renders the screens of the design and talks to the main process through `src/shared/api.ts`.
The main process uses `src/main/sim.ts` as its state machine. Zwift (`zwift.ts`) and MyWhoosh (`mywhoosh.ts`) plug into it as real adapters; without them (development without `bin/rollout-run`) it stays a simulation.
The launcher update (`src/main/selfupdate.ts`) is independent of that and real, see below.

## Commands

```sh
npm install
npm run build        # bundles into dist/
npm start            # builds and starts
npm run test:unit    # VDF, Steam, config, Bluetooth, zoom, self-update (U1 to U9), watcher (W1 to W12), release tool
npm test             # type check, unit tests, build, click test (needs a display session)
```

The click test `test/smoke.mjs` restarts the app for each scenario, walks through all views and, with `ROLLOUT_SHOTS=<dir>`, saves screenshots.
On systems without `electron` on the path: `ELECTRON_BIN=<path> ELECTRON_RUN_AS_NODE=1 <path> test/smoke.mjs`.
The frame, fakes and throwaway directories live in `test/harness.mjs` and are enforced so they cannot be overridden (Steam fake, Bluetooth fake, `ROLLOUT_SELFUPDATE=fake`, throwaway `ROLLOUT_HOME` and `ROLLOUT_CONFIG_HOME`).
Scenarios S1 to S4 (launcher update UI) run with `ROLLOUT_SIM_SELFUPDATE`; S5 to S8 (full run with real Electron and the watcher, throwaway installation) need
`ROLLOUT_ELECTRON_DIR=<directory containing the file electron>` and a built `dist/`, otherwise they are skipped. `ROLLOUT_ELECTRON_OLD=<directory with Electron 44>` enables A3 (back to an older major version with the same profile). `ROLLOUT_ONLY=<prefix>` selects scenarios. `rollout-run` has its own tests (`test/run.test.mjs`, run with `npm run test:unit`). On the Ally set `DISPLAY=:0` and a `TMPDIR` on btrfs.

## Fixed path and Steam

After `npm run build`, `scripts/install.sh [Electron directory]` puts everything under `~/.local/share/rollout` (`$ROLLOUT_HOME` overrides it):

```text
bin/rollout            starter and watcher (scripts/bin-rollout.sh), Steam target, its path never changes
bin/rollout-run        game starter (scripts/bin-rollout-run.sh): cleans the environment, keeps the screen awake, state/run.pid; Zwift through the container runtime (below)
zwift/<commit>/zwift.sh  start script from netbrain/zwift, pinned in upstreams.json, downloaded and verified by the Zwift adapter (src/main/zwift.ts); ROLLOUT_ZWIFT_SCRIPT replaces it
current -> versions/<v>   previous -> versions/<v>
versions/<v>/          package.json, dist/, vendor/ (mywhoosh.sh, ble-bridge.py, licence), bootstrap/rollout, runtime (name of the Electron directory)
electron/<v>/          Electron
staging/ state/        download and unpack area, watcher state (lock, pending, trial, healthy, bad, notice, boot.log, check.json)
icon.png
```

An old layout (`app/dist`, `app/electron`) is migrated on the next run and keeps its Electron. Without an argument an existing Electron stays, otherwise `node_modules/electron/dist` is used;
with `REPLACE_ELECTRON=1` and an argument, or `ELECTRON_DIR`, another one is taken. Quit Rollout first.

## Launcher update

The watcher `bin/rollout` stays as the parent process of Electron (`ROLLOUT_SUPERVISED=1`), swaps `current` by `rename`, starts the new version on trial
and switches back to `previous` after two failures. Without the watcher (`npm start`) there is no check and no row with a button in the settings.
`src/main/selfupdate.ts` verifies a signed manifest (Ed25519, `node:crypto`), downloads the app archive and, if needed, the Electron archive, checks size and SHA-256, stages the version and writes `state/pending` last.
The network sits behind `Feed` (`selfupdate-net.ts`, main process only); the fakes live in `selfupdate-fake.ts`. In the main process, paths come only from `__dirname`, never from `app.getAppPath()` (it points to the symlink).

**Keys:** `src/main/selfupdate-keys.ts` lists the public keys. As long as no public key is registered, the client does not check at all and rejects everything. The real key is created only at publication.

**Building a release** (local only, no upload):

```sh
npm test
node scripts/release.mjs pack --runtime <Electron directory>        # or --runtime-from <earlier rollout-update.json>
node scripts/release.mjs check --electron <Electron directory> [--previous <rollout-<v>-app.tar.gz>]
```

`pack` writes the archives and the signed `rollout-update.json` to `release-out/` (excluded by `.gitignore`) and asks for the key's passphrase
(`--key`, otherwise `~/.config/rollout-release/rollout-update-1.pem`; `ROLLOUT_RELEASE_PASSPHRASE` replaces the prompt). `check` is the release probe: previous release onto the candidate,
then the candidate onto an artificial version +1, with a test key and a real Electron. Tag, draft, upload and publication follow by hand.

**Settings:** `update_channel = "stable"` or `"beta"` in `config.toml` (deviations only), operated under Advanced, tab "Launcher". "Download updates automatically" also applies to the launcher.

Rollout starts fullscreen when Steam starts it or Gaming Mode is running. `--fullscreen` forces that, `--windowed` prevents it, `F11` toggles.

At the top right, the round button next to "Settings" quits the app after a confirmation.

In the settings, the "Rollout in Steam" switch creates a non-Steam entry for `bin/rollout` or removes it (`src/main/steam.ts`, `vdf.ts`).
Flow: if Steam is running, Rollout asks "Steam needs to restart briefly", closes Steam, writes `shortcuts.vdf` and starts Steam again.
Writing happens with a backup (`shortcuts.vdf.rollout-backup-*`, the last three are kept), verification and atomic rename. Foreign entries are preserved byte for byte.
Rollout also generates the library images (portrait, landscape, background with the MyWhoosh photo, logo) in `config/grid`, named after the AppID (`src/main/artwork.ts`). Steam shows them after its next start.
Native Steam in Desktop Mode only. Flatpak, Snap and Gaming Mode report "not available".

## Simulated states

| Variable | Effect |
| --- | --- |
| `ROLLOUT_SIM_STATE=fresh` | no app installed |
| `ROLLOUT_SIM_UPDATE=1` | an update is available for installed apps |
| `ROLLOUT_SIM_CRASH=1` | the game exits after the start |
| `ROLLOUT_SIM_LANG=de` | fix the language, otherwise the saved one or the system language |
| `ROLLOUT_SIM_THEME=light` | fix the appearance (`dark` or `light`) |
| `ROLLOUT_SIM_SCALE=125` | fix the size |
| `ROLLOUT_CONFIG_HOME=<dir>` | location of `config.toml`, a throwaway directory in tests |
| `ROLLOUT_BT=fake` | Bluetooth fake instead of `bluetoothctl`; `ROLLOUT_SIM_BT=problem` makes the adapter fail |
| `ROLLOUT_MYWHOOSH=real\|sim` | MyWhoosh real (`vendor/mywhoosh.sh` through `rollout-run`) or simulated; without it, real as soon as `bin/rollout-run` and `vendor/mywhoosh.sh` exist. The click test forces `sim` |
| `MYWHOOSH_ROOT=<dir>` | moves `mywhoosh.sh`'s game directory (otherwise `~/Games/mywhoosh-linux`), a throwaway directory in tests |
| `ROLLOUT_SIM_STEAM=fake` | replace Steam access with a fake. The click test forces this so real Steam files are never changed |
| `ROLLOUT_SIM_STEAM_RUNNING=1` | the fake pretends Steam is running |
| `ROLLOUT_SIM_SELFUPDATE=<state>[,blocked][,fail][,previous=<v>][,notice=<v>][,next=<v>][,mb=<n>]` | fix the launcher update (`current`, `checking`, `checkFailed`, `available`, `downloading`, `ready`, `invalid`, `noSpace`, `manual`, `none`), without files and without a restart |
| `ROLLOUT_SELFUPDATE=fake` | replaces the network with `ROLLOUT_SELFUPDATE_DIR` (`rollout-update.json`, `rollout-update-beta.json`, archives by file name) and takes the public key (32 bytes, base64) from `ROLLOUT_SELFUPDATE_KEY`. Applies only with `ROLLOUT_HOME` set, otherwise the app aborts. Shortens the timings (first check 0.3 s, healthy report 1 s). `ROLLOUT_SELFUPDATE_DELAY_MS` slows down the download |
| `ROLLOUT_HOME=<dir>` | location of the installation (self-update state, Steam target), a throwaway directory in tests |
| `ROLLOUT_BOOT_TIMEOUT`, `ROLLOUT_BOOT_GRACE` | trial time limit (60 s) and deadline between TERM and KILL (5 s) in the watcher, shortened in tests |

## Languages

English is the source language (`src/renderer/locales/en.ts`). Available: English, German, Spanish, French, Italian, Portuguese, Dutch, Polish. Japanese and Chinese are deliberately not included. Another language is a file in the same directory that satisfies the `Messages` type,
plus an entry in `src/renderer/i18n.ts`. If a key is missing, the type check reports it. The language follows the system and can be changed in the settings.

## Settings

Language, appearance (Automatic, Dark, Light), UI size and "Download updates automatically" are saved in `~/.config/rollout/config.toml`, and only deviations from the defaults (`src/main/config.ts`, `ROLLOUT_CONFIG_HOME` moves the directory).

The UI is designed for 1280 × 800. "Automatic" scales it with the window (an Ally at 1920 × 1080 shows 135 %), never below 100 %. Manual values go up to 175 % and are capped to what still fits in 1024 × 640 (`src/main/zoom.ts`).

## Bluetooth

The scan uses `bluetoothctl` (`src/main/bluetooth.ts`) and shows trainers (FTMS or Cycling Power) and heart-rate straps that are currently broadcasting. Nothing is paired.
`ROLLOUT_BT=fake` replaces it with a fake; the click test forces that. By hand with a real adapter: `ROLLOUT_REAL_BT=1 ROLLOUT_ONLY=bluetooth-real` for the click test.

## Operation

Select fields open a list of their own inside the app instead of the native menu, because controller and touch cannot operate the native one in Gaming Mode.

Mouse, touch, keyboard and controller: arrows, d-pad and left stick move the focus, Enter or A activates, Esc or B goes back, the right stick scrolls.
In Desktop Mode under Steam the gamepad does not reach Chromium (gate G4, E1); in Gaming Mode it works.

## Licence

Rollout is released under the MIT licence, see [LICENSE](../LICENSE). Third-party components (Electron, the Archivo and Figtree fonts) keep their licences, see [THIRD_PARTY_LICENSES.md](../THIRD_PARTY_LICENSES.md). Zwift and MyWhoosh are trademarks and games of their vendors; Rollout is not affiliated with or endorsed by them.

## Brand

`src/renderer/assets/brand/`: `logo.svg`, `logo-currentcolor.svg`, `wordmark.svg` (text in Archivo, the font has to be loaded), `logo.png`.

## MyWhoosh (`src/main/mywhoosh.ts`, `vendor/`, `upstreams.json`)

MyWhoosh runs through our own copy of `mywhoosh.sh` from [Parapeth962/mywhoosh-linux-installer](https://github.com/Parapeth962/mywhoosh-linux-installer) (MIT, licence in `vendor/`), pinned in `upstreams.json` (`mywhoosh`: commit of the original, SHA-256 of both files; `test/mywhoosh.test.mjs` M16 checks that `vendor/` matches).
`ble-bridge.py` belongs with it: `mywhoosh.sh install` copies it into the game directory and aborts without it. The shim and helper by Dj0ulo (no licence) are downloaded by the script itself from the original release and verified by checksum; they are not in the repo.
`vendor/` goes into every release (`scripts/release.mjs`, `scripts/install.sh`) and sits next to `dist/` of the running version; `rollout-run mywhoosh` starts `current/vendor/mywhoosh.sh run`.

- **State:** from disk, not from memory: installed if `~/Games/mywhoosh-linux/game/MyWhoosh/Binaries/Win64/MyWhoosh-Win64-Shipping.exe` exists (HD: `~/Games/mywhoosh-hd-linux`, `MYWHOOSH_ROOT` moves the directory). The version is in `AppxManifest.xml` and appears in the app menu under the name (`AppInfo.version`).
- **Install, update, remove:** `rollout-run --mywhoosh install [--hd]|update|uninstall` (screen stays awake, no `run.pid`, exit 1 if a game is running). Output and errors go to `state/mywhoosh.log`. Error kinds from the output: `net` (download failed), `verify` (checksum/digest mismatch), `disk` (not enough space, checked beforehand: 14 GB, HD 38 GB), otherwise `error`.
  Progress is an estimate: bytes written in `cache/`, `game/` and `game.new/` against 9 GB (HD 31 GB), plus minimum values from lines ("preparing Windows environment" 92 %). A game directory without a game (leftover of an aborted attempt) is deleted before setup; a game never. `state/mywhoosh-setup.pid` prevents two setups at once, even across a Rollout restart.
- **Start:** Bluetooth check (`bluetooth.ts`); on a problem, the "Check Bluetooth" card with "Start anyway"; then `rollout-run mywhoosh`. Phases from the output: "Updates" (the script checks for a newer version itself at start and downloads it, which can take minutes), "Starting" from the line `starting MyWhoosh`, "Running" after 20 s (`ROLLOUT_MYWHOOSH_RUNNING_MS`). **Assumption, not confirmed:** MyWhoosh does not report "running"; the 20 s are an estimate. Errors within 90 s show the crash view, exit 127 "cannot start".
- **Quit:** TERM to `rollout-run`, which starts the game in a session of its own (`setsid`) and, on quit, sends TERM to the whole group (Wine, umu and the Bluetooth helper are not part of the script's process tree), KILL after 12 s (`ROLLOUT_RUN_KILL_AFTER`). If Steam ends Rollout, Rollout stops the game first (`hasRunningGame`); a running setup is aborted.
- **Controller in Gaming Mode:** MyWhoosh's UI shows no focus when navigating with the gamepad, and an A can quit it. Therefore Wine no longer sees the Steam gamepad: `rollout-run` sets `SDL_GAMECONTROLLER_IGNORE_DEVICES=0x045e/0x028e` (only with `xdotool`, never with `ROLLOUT_MYWHOOSH_PAD=off`, a user-set value wins). Instead, as with Zwift, Rollout forwards it as keyboard and mouse (`gamepad-bridge.ts`, pointer mode: both sticks move the pointer, the d-pad in 12-pixel steps, **A left click**, B/Start Esc, RT/LT clicks, LB/RB scrolling; no arrow keys, so the game never ends up with an invisible focus), but only once the MyWhoosh window (WM_CLASS contains `mywhoosh`) is the window focused by gamescope (`watchZwiftWindow` with `tag: false`, sets no `STEAM_GAME`). Display: the inherited `DISPLAY` (`ROLLOUT_MYWHOOSH_DISPLAY`), focus from `:0`. Log: `state/mywhoosh-window.log`. `ROLLOUT_MYWHOOSH_WINDOWS=off` switches window and controller off. Rollout's own UI ignores the gamepad in the phases "Starting" and "Running" (`nav.ts`, `padEnabled`) so an A does not also click "Quit game".
  **Not confirmed:** whether Wine reads the gamepad through SDL and the variable hides it, and which WM_CLASS the window really carries; both need to be checked on the Ally (read the log).
- **Round pointer:** Rollout creates an X cursor theme under `state/cursors/rollout-dot/` (white circle with a dark rim and blue centre, 48 px, `xcursor.ts`) and passes it to the game through `XCURSOR_PATH`, `XCURSOR_THEME`, `XCURSOR_SIZE`. `ROLLOUT_MYWHOOSH_CURSOR=off` keeps the normal pointer. **Not confirmed:** Wine often draws the pointer from the image the application supplies itself and then ignores the theme; whether it takes effect on the Ally needs to be checked.
- **Bluetooth in the app menu:** The row shows the real state of `bluetoothctl show` (`Powered: yes`), fresh every time the menu opens and before every start. The query does not block the main process.
- **Remove:** confirmation in the UI, then `uninstall` (deletes game, prefix and login; Proton stays). If it fails, MyWhoosh stays installed and the card says so.
- **Not implemented:** detecting a newer store version before the start (`updateAvailable` stays `false`; updating happens at start), pre-checking Python `dbus`/`gi`, cancelling the setup with a button, a Steam entry per game (the switch only sets the flag, as with Zwift).
- **Tests:** M1 to M19 in `test/mywhoosh.test.mjs` (fake `mywhoosh.sh`, real `rollout-run`, `HOME` and `MYWHOOSH_ROOT` in a throwaway directory), R30 to R34 in `test/run.test.mjs`. The click tests force `ROLLOUT_MYWHOOSH=sim`; `real` runs there only with a fake upstream and a game directory under `/tmp`.

## Zwift through netbrain/zwift

`rollout-run zwift` starts netbrain/zwift's `zwift.sh` (container, Podman before Docker) with `CONTAINER_TOOL`, `IMAGE`, `VERSION`, `DONT_UPDATE=1` and `ZWIFT_FG=1`.
Beforehand it checks whether the runtime is usable (program present, `info` works, permissions and service) and otherwise explains what is missing. It never installs anything.

The image is fixed, never `latest`: in `~/.config/rollout/config.toml` (or via `ROLLOUT_ZWIFT_TAG`, `ROLLOUT_ZWIFT_DIGEST`, `ROLLOUT_ZWIFT_IMAGE`)

```toml
zwift_tag = "1.2.3"                 # mandatory, tag from docker.io/netbrain/zwift
zwift_digest = "sha256:…"           # optional: then exactly this digest is pulled and named locally as the tag
```

Pulling happens only with consent for exactly this reference: `rollout-run --zwift-pull` (from the launcher after confirmation, or by hand) pulls and remembers the consent in `state/zwift-image-ok`.
`rollout-run --container-check` names the usable runtime. Exit codes: 10 no runtime, 11 image not configured, 12 image missing or pull failed, 13 removal failed, 127 `zwift.sh` missing.
`rollout-run --zwift-remove` removes the configured image with `rmi image:tag` and deletes `state/zwift-image-ok` (exit 0 without an image too; on error exit 13 and the consent stays). Call only after asking the user; the runtime and `zwift.sh` stay.
`rollout-run --zwift-status` prints `runtime=`, `ref=`, `image=present|missing` and `consent=yes|no` (pulls and starts nothing; exit 10 or 11 as above). If `USER` is missing, `rollout-run` sets it for `zwift.sh`.
Tests R9 to R20 and R35 to R39 in `test/run.test.mjs` use fakes for `podman` and `docker`.

### Zwift adapter (`src/main/zwift.ts`, `upstreams.json`)

`upstreams.json` pins `zwift.sh` (repo, commit, path `src/zwift.sh`, SHA-256) and names the default image with its tag; it is bundled into the main process at build time. The adapter
downloads `https://raw.githubusercontent.com/<repo>/<commit>/<path>` (at most 256 KiB), checks the SHA-256, creates the file under `zwift/.staging-*` and moves it with `rename` to
`zwift/<commit>/zwift.sh` (executable). Afterwards scripts of other commits disappear. A modified or non-executable script counts as missing and is replaced. To set a new pin:
enter the commit and the file's `sha256sum` in `upstreams.json`; `ROLLOUT_ZWIFT_NET=1 node --test test/zwift.test.mjs` checks the pin against GitHub.

Connection to `SimBackend`: without `ROLLOUT_ZWIFT`, Zwift counts as real as soon as `bin/rollout-run` exists and the pin in `upstreams.json` is valid (`chooseZwiftMode`); otherwise it stays simulated.
`ROLLOUT_ZWIFT=real|fake|sim` forces the choice. In real mode Zwift counts as installed when the pinned script exists and `--zwift-status` reports the image (state on every snapshot, queried at most every 5 s,
not during installation, removal and game).

- **Install:** the UI asks first ("Download the Zwift image?" with the tag from `Snapshot.zwiftTag` and the approximate size); only the confirmation starts it. Then the adapter downloads `zwift.sh`, writes the tag from
  `upstreams.json` as `zwift_tag` if none is configured (environment `ROLLOUT_ZWIFT_TAG` before `config.toml` before pin), and pulls the image with `rollout-run --zwift-pull`. Progress counts finished image layers (estimate).
- **Errors:** `apps.zwift.problem` (`net`, `verify`, `disk`, `runtime`, `tag`, `pull`, `error`) appears as a "Needs attention" pill on the card and as a sentence with the next step in the install view
  ("Try again" button); a failed installation leads back there. Texts in all 8 languages (`problem.*` in `src/renderer/locales`).
- **Start:** `launch('zwift')` starts `rollout-run zwift` in a process group of its own. Phases from the output: "Preparing the container", from the `zwift.sh` line `Launching Zwift` "Starting Zwift", from the container's message `Zwift started using wine`
  (after about 5 s on the Ally) "Running", at the latest after `ROLLOUT_ZWIFT_RUNNING_MS` (default 20000). Whether the window is visible in Gaming Mode (gamescope) is detected by Rollout itself (`src/main/zwift-window.ts`, "path A"): it looks for the `zwiftapp.exe` window on the X server `:0`, sets `STEAM_GAME` to the AppID of its own Steam entry (from the process tree; `reaper SteamLaunch AppId=…`) and reports "visible" (`onVisible`) as soon as `GAMESCOPE_FOCUSED_WINDOW` is this window, and "not visible" again on quit. It also revokes the `xhost +local:` opened by `zwift.sh` after the game if it was not set before. `ROLLOUT_ZWIFT_WINDOWS=off` switches this off, `ROLLOUT_ZWIFT_DISPLAY=<:N>` selects the X server (default `:0`). Confirmed on the Ally. Without a start from Steam (no AppID in the process tree) the window stays without `STEAM_GAME`. If the start line is missing, the display moves on after 8 s anyway. Rollout does not check Bluetooth for Zwift.
  Exit 0 = game ended; exit 10, 11, 12, 127 = "cannot start" with a reason (`Launch.problem`, phase `failed`); any other error within 90 s = "closed right after the start". "Quit game" sends TERM to `rollout-run`; that stops the container with `podman stop -t 10 zwift-${ZWIFT_RIDER:-$USER}` (a TERM to the whole
  group left it running as an orphan on the Ally, its PID 1 ignores TERM) and waits until `state/run.pid` is gone (about 12 s, because the container ignores TERM and `podman stop -t 10` kills it after 10 s); during that time the card shows "Closing …" (`Launch.phase = 'stopping'`) and a new start is blocked. After 60 s KILL to the group. On quit `rollout-run` first ends Zwift in an orderly way so netbrain's script still copies the data into the volume (see "Settings"): `taskkill /im ZwiftApp.exe` in the container, after 8 s (`ROLLOUT_ZWIFT_QUIT_WAIT`) `taskkill /f`, wait up to 15 s (`ROLLOUT_ZWIFT_KILL_WAIT`), then always `podman stop`. Test R35. If the user sets `ZWIFT_RIDER` only in netbrain's own config, the starter does not know the name (known limitation).
- **Settings and login:** Zwift 1.124.0 in netbrain's container keeps its user data in `Documents/Zwift` (its log: `Using user data path: C:\users\user\DOCU~OWL`; netbrain's script reports `Zwift is using Documents/Zwift instead of AppData/Local/Zwift`), while `AppData/Local/Zwift` only gets caches (about 60 MB).
  netbrain's `run_zwift.sh` syncs only `ZWIFT_DATA_DIR` (in the image `AppData/Local/Zwift`) with the volume `zwift-<rider>`, so before 0.9.0-beta.3 every run started from scratch (`Client version check: FIRST_RUN`).
  `rollout-run` therefore passes `CONTAINER_EXTRA_ARGS=-e ZWIFT_DATA_DIR=…/Documents/Zwift` (a user string is appended; netbrain warns that it is a string, that is expected; `ROLLOUT_ZWIFT_DATA=appdata` keeps netbrain's default). Test R38.
  netbrain copies back only after `ZwiftApp.exe` has exited. "Exit game" in Steam sends TERM to every process below Rollout, also to `podman run`, which passes it on: the container ends at once and that copy never happens (seen on the Ally).
  Therefore `rollout-run` also runs netbrain's `rsync -au` inside the container every `ROLLOUT_ZWIFT_SYNC_EVERY` seconds (30, `0` = off); a hard end loses at most that much. Test R39.
  **The login itself is not kept:** Zwift's in-game login (`Legacy Launcher Used`) keeps the token only in memory; after logging in only the e-mail address lands in `prefs.xml`, nothing in the Wine registry (compared on the Ally).
  Staying logged in works only through netbrain's automatic login (`ZWIFT_USERNAME` and the password, see netbrain's documentation "Authentication").
- **Output log:** `rollout-run zwift` copies everything `zwift.sh` and the container print (stdout and stderr together, also still passed on) to `state/zwift-run.log`; the two runs before stay as `.1` and `.2`; first line start, last line exit code. The copy runs through a FIFO and `tee`, which ignores INT/TERM/HUP so a Ctrl+C or Steam's TERM cannot kill the game through SIGPIPE; `ulimit -f` caps the file at 20 to 40 MB. `ROLLOUT_ZWIFT_LOG=off` switches it off. Zwift's own log ends up in the volume as `Logs/Log.txt`. Tests R36, R37.
- **State:** Rollout queries it on every check (at most every 5 s) from the container runtime (`rollout-run --zwift-status`). If `config.toml` has no tag yet, it queries with the pinned tag so the runtime and an already existing image are recognised. If the image exists and only `zwift.sh` is missing, Rollout quietly downloads the script. The installer shows netbrain/zwift (link) and whether Podman/Docker was found (`Snapshot.zwiftRuntime`).
- **Network:** `rollout-run` sets `NETWORKING=host` (netbrain's `zwift.sh`) because otherwise the Zwift Companion app does not find the game on the Wi-Fi (confirmed on the Ally); the container thereby shares the host's network. A `NETWORKING` set from outside still applies. Direct Bluetooth in the container does not work (`BLE_LOAD_FAIL`, Wine does not load the BLE library, even with `DISABLE_BLUETOOTH=0`): the Companion app pairs sensors.
- **Controller:** Zwift does not know gamepads, Rollout's Steam layout is one. While the Zwift window is visible, Rollout reads Steam Input's virtual gamepad (`Microsoft X-Box 360 pad <N>` under `/dev/input`, readable for the user) and forwards it via `xdotool` as keyboard and mouse to gamescope (`gamepad-bridge.ts`): d-pad and left stick arrow keys, A Enter, B and Start Esc, X Tab, Y Shift+Tab, Select Backspace, right stick mouse, RT left click, LT right click, R3 click, LB/RB scrolling. No template and no setting in Steam needed. Can be switched off with `ROLLOUT_ZWIFT_PAD=off`. Needs `xdotool` (present on Bazzite).
  While the Zwift window is visible, Rollout's own UI ignores the gamepad (`padAllowed` in `src/renderer/nav.ts`, test N1): it gets the same virtual gamepad, and its running view has only "Quit game". Before 0.9.0-beta.3 arrow down focused that button and the A for "log in with existing account" pressed it, so Zwift seemed to crash on the login form.
- **App menu:** The gear on the card opens the Steam switch, for MyWhoosh the Bluetooth setup, the advanced settings and uninstalling.
- **Quitting Rollout:** If Steam ends Rollout (quit game, window closed, TERM/INT/HUP), Rollout first stops the running game (`before-quit`, signals in `main.ts`); confirmed on the Ally.
- **Remove:** confirmation with tag and size, then `rollout-run --zwift-remove`. If it fails (for example a container is still running), Zwift stays installed, and the card and the row under "Remove an app" say so.
  `zwift.sh` and the container runtime stay.
- **Fake:** `ROLLOUT_ZWIFT=fake` replaces network and container (state via `ROLLOUT_SIM_ZWIFT`: empty, `ready`, `norun`, `nonet`, `nopull`, `runcrash`, `runfail`, `norem`).
  The click tests force `ROLLOUT_ZWIFT=sim` unless a scenario requires otherwise; `real` runs there only with container fakes on PATH and a replaced upstream (`ROLLOUT_RUN_UPSTREAM`), otherwise the harness aborts.

Tests Z1 to Z29 in `test/zwift.test.mjs` (download and pin, `rollout-run` with container fakes, integration, start, quit, removal; Z13 only with `ROLLOUT_ZWIFT_NET=1` against the real GitHub). Click tests `zwift-*` in `test/smoke.mjs`; `zwift-real` (script from GitHub, fakes) only with `ROLLOUT_ZWIFT_NET=1`.
