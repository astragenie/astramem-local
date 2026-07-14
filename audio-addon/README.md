# astramem-audio

Optional on-device whisper.cpp add-on for [astramem-local](https://github.com/astragenie/astramem-local)'s
audio-file transcription capture (FEAT-489). Kept out of the base `astramem-local` package so the
base install stays light — see `docs/research/2026-07-14-audio-addon-packaging.md` in the main repo
for the full packaging design pass (presence probe, version handshake, publish pipeline, whisper.cpp
distribution decisions).

## Status: skeleton (Slice A)

This package currently exports only the API-version handshake constant and a `transcribe` stub that
throws — it is package layout only, proving the shape astramem-local's presence/version probe checks
for. The real whisper.cpp binding, model download, and prebuilt CPU-only binaries (linux-x64 first,
per the packaging design pass's v1 platform-scope decision) ship in Slice B. astramem-local's
`transcribe` pipeline handler and `audio-addon` doctor check both already handle this package being
absent entirely as a normal, non-crashing state — installing this skeleton does not currently unlock
working audio ingestion.

## Consent (ADR-017)

Enabling audio capture in astramem-local (`audio.mode` != `'off'`) records the voices of everyone in
a captured recording, not just the operator's own. This is default-OFF and requires explicit,
disclosed opt-in in astramem-local — recording or transcribing someone without their knowledge is
restricted or illegal in many places. See `docs/adr/ADR-017-third-party-speaker-consent-model.md` in
the main repo.

## Publishing

Not yet wired to a publish workflow — that is Slice B (`audio-v*` tag namespace, mirroring
`contracts/`'s `contracts-v*` pattern). This package is not on npm yet.
