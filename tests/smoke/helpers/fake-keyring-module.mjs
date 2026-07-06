// tests/smoke/helpers/fake-keyring-module.mjs
//
// Drop-in replacement for '@napi-rs/keyring' used ONLY via the resolve hook
// in fake-keyring-hooks.mjs (encrypted-restart smoke test). Every method
// throws (or returns a harmless falsy value for the delete methods) so
// src/storage/keystore.ts's try/catch chain always falls through to its
// documented fallback (key-file for the db key, secrets.env for the bearer)
// instead of touching a real OS credential store. Mirrors the stub shape
// already used in-process by tests/security/encryption.test.ts via
// `__setEntryCtorForTests` — this is the same idea, just applied across a
// process boundary (a real spawned daemon) via a module resolve hook instead
// of an in-process constructor swap.
export class Entry {
  constructor(_service, _account) {
    throw new Error(
      'fake-keyring: OS credential store intentionally unavailable (encrypted-restart smoke test sandbox)',
    );
  }
  getPassword() {
    throw new Error('fake-keyring: unreachable — constructor always throws first');
  }
  setPassword(_password) {
    throw new Error('fake-keyring: unreachable — constructor always throws first');
  }
  deletePassword() {
    return false;
  }
  deleteCredential() {
    return false;
  }
}
