<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/logo.svg">
    <img src="docs/media/logo-currentcolor.svg" alt="Rollout logo" width="96">
  </picture>
</p>

<h1 align="center">Rollout</h1>

<p align="center">
  <strong>MyWhoosh &amp; Zwift on SteamOS and Bazzite. Download, double-click, ride.</strong>
</p>

<p align="center">
  <a href="https://github.com/mace-ops/rollout-cycling-launcher-linux/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/mace-ops/rollout-cycling-launcher-linux?include_prereleases&style=for-the-badge&color=E8673C"></a>
  <img alt="Platform: SteamOS and Bazzite" src="https://img.shields.io/badge/platform-SteamOS%20%C2%B7%20Bazzite-08090E?style=for-the-badge">
  <img alt="8 languages" src="https://img.shields.io/badge/languages-8-3D6BFF?style=for-the-badge">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-5CF0A0?style=for-the-badge&labelColor=08090E"></a>
</p>

<p align="center">
  <a href="https://mace-ops.github.io/rollout-cycling-launcher-linux/"><b>Website</b></a> ·
  <a href="#install"><b>Install</b></a> ·
  <a href="#features"><b>Features</b></a> ·
  <a href="#faq"><b>FAQ</b></a> ·
  <a href="docs/README.de.md">Deutsch</a>
</p>

<p align="center">
  <img src="docs/media/hero-carousel.gif" alt="Rollout in action: home screen, install, progress, Bluetooth check and settings" width="860">
</p>

Rollout is a launcher that **installs, updates and starts indoor cycling apps on Linux**. It is made for
**SteamOS** (Steam Deck) and **Bazzite** (ROG Ally and other handhelds, desktop PCs) and works completely with a
**controller**, right from Gaming Mode.

> [!NOTE]
> Rollout is in **beta**. It is tested on a ROG Ally with Bazzite. The Steam Deck with SteamOS is the second target
> and **not yet verified**. Other Linux distributions are not supported; use them at your own risk.

## Features

| | |
| --- | --- |
| 🎮 **Controller first** | Every screen works with gamepad, touch and keyboard. In Gaming Mode your controller also steers Zwift. |
| ⚡ **One-button install** | No mandatory questions, no terminal, no `sudo`. Size and time up front, then clear phases with progress. |
| 🔄 **Safe updates** | Rollout can update itself in the background. Launcher updates are signed (Ed25519), test-started and roll back on their own if the new version does not start. |
| 🕹️ **Steam integration** | One switch adds Rollout and your apps to the Steam library, with artwork. Start rides from Gaming Mode; play time survives updates. |
| 📡 **Bluetooth check** | For MyWhoosh: shows which trainers (FTMS, Cycling Power) and heart-rate straps are sending before you ride, and can restart a stuck adapter. |
| 🌍 **8 languages** | English, Deutsch, Español, Français, Italiano, Português, Nederlands, Polski. Follows your system language. |
| 🧑‍🦳 **For everyone** | Big buttons, light and dark mode, interface size up to 200 %. Behind “Advanced”: Proton version, graphics output, Bluetooth adapter, update channel, logs, diagnostics. |

### Two apps, the right setup for each

| | MyWhoosh | Zwift |
| --- | --- | --- |
| Runs with | GE-Proton | Container from [netbrain/zwift](https://github.com/netbrain/zwift) (Podman or Docker) |
| Sensors | Direct Bluetooth, paired in the game | Zwift Companion on your phone or Direct Connect (no direct Bluetooth in the container) |
| Controller in game | Gamepad mapped to the mouse pointer by Rollout (new, not yet verified on a handheld) | Gamepad mapped to keyboard and mouse by Rollout |

## Screenshots

<table>
  <tr>
    <td><img src="docs/media/screens/en/installing.jpg" alt="Installing Zwift at 46 percent with the phases listed"></td>
    <td><img src="docs/media/screens/en/bluetooth.jpg" alt="Bluetooth check listing a trainer and a heart-rate strap"></td>
  </tr>
  <tr>
    <td align="center"><b>Install</b> – clear phases, honest time estimate</td>
    <td align="center"><b>Bluetooth</b> – find your sensors before the ride</td>
  </tr>
  <tr>
    <td><img src="docs/media/screens/en/settings.jpg" alt="Settings: language, interface size, appearance, updates and Steam"></td>
    <td><img src="docs/media/screens/en/advanced.jpg" alt="Advanced settings for MyWhoosh with recommended values"></td>
  </tr>
  <tr>
    <td align="center"><b>Settings</b> – language, updates, Steam</td>
    <td align="center"><b>Advanced</b> – every option shows the recommendation</td>
  </tr>
</table>

The screenshots show the real app with simulated data (no account, no game running).

## Install

<p align="center">
  <a href="https://github.com/mace-ops/rollout-cycling-launcher-linux/releases"><img alt="Download for SteamOS" src="https://img.shields.io/badge/SteamOS%20download-coming%20soon-6B6F7A?style=for-the-badge" height="44"></a>
  &nbsp;
  <a href="https://github.com/mace-ops/rollout-cycling-launcher-linux/releases"><img alt="Download for Bazzite" src="https://img.shields.io/badge/Bazzite%20download-coming%20soon-6B6F7A?style=for-the-badge" height="44"></a>
</p>

> [!IMPORTANT]
> The `Rollout.desktop` download is not available yet. The buttons above lead to the releases page until it is published.

1. Switch to **Desktop Mode** (SteamOS: Steam button → Power → Switch to Desktop; on a PC with Bazzite you are already there).
2. Download `Rollout.desktop` and **double-click** it in *Downloads*.
3. Confirm the prompt once. Rollout appears in your app menu.

No terminal, no password. Rollout installs into `~/.local/share/rollout` and does not change system packages.

| System | Devices | Status |
| --- | --- | --- |
| **Bazzite** (KDE) | ROG Ally, other handhelds, desktop PCs | beta, tested on ROG Ally |
| **SteamOS** | Steam Deck LCD & OLED | beta, **not yet verified** |
| Bazzite with GNOME | – | the file manager does not start downloaded `.desktop` files by double-click, so the install does not work there yet |
| Other Linux | – | not supported, at your own risk |

**Requirements:** 8–21 GB free space per app (MyWhoosh 4 GB download, 8 GB installed, “better graphics” 15 and 20 GB; Zwift about 6 GB download, 20 GB installed),
internet for the first install, Bluetooth for MyWhoosh sensors. Zwift needs Podman or Docker: Podman is included in Bazzite, SteamOS usually does not ship it and Rollout does not
install system packages. MyWhoosh needs neither.

## Controller

| Input | In Rollout | In Zwift (Gaming Mode) |
| --- | --- | --- |
| D-pad · left stick · arrow keys | Move focus | Arrow keys |
| **A** · Enter | Select | Enter |
| **B** · Esc | Back | Esc |
| Right stick | Scroll | Mouse pointer |
| X · Y · Select · Start | – | Tab · Shift+Tab · Backspace · Esc |
| Triggers · LB/RB · R3 | – | Left/right click · scroll · click |

In MyWhoosh Rollout maps the gamepad to the mouse pointer instead (sticks move it, **A** clicks). This is new and not yet verified on a handheld; see the [developer guide](app/README.md).

## How it works

Rollout is a thin launcher. It does not patch games; it drives open projects that already do the hard work:

- **MyWhoosh:** own copy of [Parapeth962/mywhoosh-linux-installer](https://github.com/Parapeth962/mywhoosh-linux-installer) (MIT), which loads the Bluetooth shim from [Dj0ulo/mywhoosh-linux](https://github.com/Dj0ulo/mywhoosh-linux).
- **Zwift:** [netbrain/zwift](https://github.com/netbrain/zwift), pinned to a commit and SHA-256 in [`app/upstreams.json`](app/upstreams.json).
- **Launcher updates:** signed manifest from GitHub Releases, atomic swap, automatic rollback.

Details: [developer guide](app/README.md) (German) · [website](site/README.md).

## FAQ

<details>
<summary><b>Does Zwift run on Steam Deck and Bazzite?</b></summary>

On Bazzite it does: Zwift runs in a container based on netbrain/zwift, which Rollout installs and starts. Rollout is tested on a ROG Ally with
Bazzite; the Steam Deck is not yet verified. SteamOS usually needs Podman or Docker first. Sensors connect through Zwift Companion on your phone or Direct
Connect, not directly over Bluetooth.
</details>

<details>
<summary><b>Does MyWhoosh run on SteamOS and Linux with Bluetooth?</b></summary>

Yes. MyWhoosh runs with GE-Proton and talks to your trainer and heart-rate strap over Bluetooth directly. You pair them in the game, like on Windows.
</details>

<details>
<summary><b>Does Zwift work on the ROG Ally?</b></summary>

Yes, on Bazzite. Install Rollout in Desktop Mode, then start Zwift from Rollout or from Steam in Gaming Mode. Your controller steers the game.
</details>

<details>
<summary><b>Is Rollout official? Can my account get banned?</b></summary>

No. Rollout is an independent project, not affiliated with Zwift, Inc., MyWhoosh or Valve. Their terms restrict unapproved third-party tools, and they can
suspend accounts at their discretion. Read the terms and decide for yourself.
</details>

<details>
<summary><b>Which devices and systems are supported?</b></summary>

Rollout is in beta. It is tested on a ROG Ally with Bazzite. SteamOS on the Steam Deck is the second target but not yet verified. Other Linux distributions are at your own risk.
</details>

## Contributing

Bug reports and translations are welcome. A new app language is one file in [`app/src/renderer/locales/`](app/src/renderer/locales/), a new website language one file in
[`site/i18n/`](site/i18n/). See the [developer guide](app/README.md) and the [website guide](site/README.md).

## License

Rollout is released under the [MIT license](LICENSE). Third-party components keep their licenses, see [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

## Disclaimer

Rollout is not affiliated with, endorsed or sponsored by Zwift, Inc., MyWhoosh or Valve. All trademarks belong to their owners. Using third-party tools may conflict with
the apps' terms of service.
