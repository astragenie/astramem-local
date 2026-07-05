// tests/smoke/helpers/fake-keyring-hooks.mjs
//
// ESM `resolve` hook installed by fake-keyring-register.mjs. Redirects only
// the `@napi-rs/keyring` specifier to the fake module below; every other
// import resolves completely normally.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@napi-rs/keyring') {
    return {
      url: new URL('./fake-keyring-module.mjs', import.meta.url).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
