import { createTokenCrypto } from '@/lib/crypto/tokenCrypto';

// Encryption of a Motir repository's SECRET environment values at rest (Story
// MOTIR-9795 · MOTIR-9960): the shared AES-256-GCM `lib/crypto/tokenCrypto`, the
// same versioned `v1.<iv>.<tag>.<ct>` form every other store uses.
//
// ⚠️ ONE key name and NO fallback — unlike the monitor, GitLab and import stores,
// which fall back to `GITHUB_TOKEN_ENCRYPTION_KEY`. An app's secrets are not a
// member's integration token: they must rotate, and leak, independently of every
// other key, so a deployment without this key cannot store a secret at all rather
// than quietly encrypting it under the GitHub key. Resolved at CALL time, so a
// deployment that never configures it still boots.

export const ENVIRONMENT_CONFIG_KEY_ENV = 'ENVIRONMENT_CONFIG_ENCRYPTION_KEY';

export const environmentConfigCrypto = createTokenCrypto([ENVIRONMENT_CONFIG_KEY_ENV]);
