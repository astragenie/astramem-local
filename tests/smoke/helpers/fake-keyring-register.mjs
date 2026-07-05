// tests/smoke/helpers/fake-keyring-register.mjs
//
// Bootstrap script registered via `NODE_OPTIONS="--import <this file>"` — see
// daemon.ts's makeIsolatedDaemonEnv(prefix, { encrypted: true }). Installs an
// ESM resolve hook (fake-keyring-hooks.mjs) that redirects the
// `@napi-rs/keyring` specifier to fake-keyring-module.mjs, whose `Entry`
// constructor always throws.
//
// Why: src/storage/keystore.ts's getOrCreateKey() tries the OS credential
// store (Windows Credential Manager / macOS Keychain / Linux libsecret)
// first, under the FIXED identity service='astramem-local', account='db-key'
// — the SAME identity a real production install of this daemon uses. A
// spawned test daemon with `security.encryption.enabled: true` and no
// intervention would read/write that REAL entry on the host machine, which
// is exactly the kind of real-OS-resource contact the isolated sandbox
// exists to prevent (see smoke.test.ts's header "F1" comment). Forcing the
// constructor to throw here makes getOrCreateKey() deterministically fall
// through to its documented key-file fallback (`<configDir>/db.key`)
// instead — a real SQLCipher key, just never touching the OS credential
// store. This file is test-only infrastructure; it is never imported by
// product code and never shipped to users (dist/ does not include tests/).
import { register } from 'node:module';

register('./fake-keyring-hooks.mjs', import.meta.url);
