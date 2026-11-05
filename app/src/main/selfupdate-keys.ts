// Public Ed25519 keys for the self-update (32 bytes each, base64), concept 6.4.
// Without entries the client does not check at all and rejects every manifest.
// `rollout-update-1` signs every release, `rollout-update-2` is the reserve and is kept offline only.
export const UPDATE_KEYS: Record<string, string> = {
  'rollout-update-1': 'MKA7ou2JKxUvM/u4V28XRrmZQISGaA580GpIhDKB8mA=',
  'rollout-update-2': 'YFk/bbrbHzIlAGgV86NCFLqXzDNKKg+qDcm8FI1SrZo='
};
