# Third-party licences

Rollout itself is released under the MIT licence (see [LICENSE](LICENSE)). These components come from others and keep their licence.

| Component | Use in Rollout | Licence |
| --- | --- | --- |
| Electron | UI runtime (`app/package.json`) | MIT, © OpenJS Foundation and Electron contributors |
| Archivo (font) | `app/src/renderer/assets/fonts/archivo.woff2` | SIL Open Font License 1.1, text in [archivo-OFL.txt](app/src/renderer/assets/fonts/archivo-OFL.txt) |
| Figtree (font) | `app/src/renderer/assets/fonts/figtree.woff2` | SIL Open Font License 1.1, text in [figtree-OFL.txt](app/src/renderer/assets/fonts/figtree-OFL.txt) |
| mywhoosh-linux-installer (`mywhoosh.sh`, `ble-bridge.py`) | `app/vendor/`, pinned in `app/upstreams.json` | MIT, text in [LICENSE-mywhoosh-linux-installer](app/vendor/LICENSE-mywhoosh-linux-installer) |

Not contained in this repo and obtained only through the adapter:

- Zwift and MyWhoosh (games, the vendors' own licence terms)
- netbrain/zwift (basis for the Zwift path, the project's licence applies)
- Dj0ulo scripts (no licence, not shipped)
