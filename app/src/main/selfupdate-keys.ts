// Öffentliche Ed25519-Schlüssel für das Selbst-Update (je 32 Byte, Base64), Konzept 6.4.
// Ohne Einträge prüft der Client gar nicht und lehnt jedes Manifest ab.
// `rollout-update-1` signiert jedes Release, `rollout-update-2` ist die Reserve und liegt nur offline.
export const UPDATE_KEYS: Record<string, string> = {
  'rollout-update-1': 'MKA7ou2JKxUvM/u4V28XRrmZQISGaA580GpIhDKB8mA=',
  'rollout-update-2': 'YFk/bbrbHzIlAGgV86NCFLqXzDNKKg+qDcm8FI1SrZo='
};
