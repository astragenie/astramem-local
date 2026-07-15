# astramem-audio

Optional on-device whisper.cpp add-on for [astramem-local](https://github.com/astragenie/astramem-local)'s
audio-file transcription capture (FEAT-489). Kept out of the base `astramem-local` package so the
base install stays light — see `docs/research/2026-07-14-audio-addon-packaging.md` in the main repo
for the full packaging design pass (presence probe, version handshake, publish pipeline, whisper.cpp
distribution decisions).

## Status: real implementation (Slice B)

Wraps the official [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp) CLI binary (MIT
license, built by that project's own GitHub Releases CI — the same "upstream project's own release CI
builds the platform binary" pattern `sqlite-vec` already uses elsewhere in astramem-local). **Compiled
CPU-only, pinned, not a preference** — see the design doc's decision 4 for the FEAT-485 VRAM-incident
reasoning this is load-bearing for. v1 platform scope: **win32-x64 and linux-x64**, both built by
ggml-org's own release CI (`whisper-bin-x64.zip` / `whisper-bin-ubuntu-x64.tar.gz`). Other platforms
report "not installed for this platform" — a handled, non-crashing state, never a build-slice blocker.

## Installation

```
npm install astramem-audio
```

The binary is bundled into the published package for win32-x64 and linux-x64 — no extra download
needed for those. The GGML model is **not** bundled (the default, `tiny.en`, is ~78MB; larger models
in the same family run up to several GB) — it downloads on first use into this add-on's own cache
directory, checksum-verified (SHA256) against a pinned manifest before being trusted:

```
bun run fetch-model          # inside audio-addon/ during local dev, or:
```

or call `ensureModel()` from code (what `transcribe()` itself expects to already have run — see below).

## API

Same shape astramem-local's `probeAudioAddon` (`src/audio/addon-probe.ts`) checks for at runtime —
unchanged from Slice A:

```ts
export const ASTRAMEM_AUDIO_ADDON_API_VERSION = 1;

interface AudioSegment {
  text: string;
  startMs: number;
  endMs: number;
  noSpeechProb: number;
  avgLogprob: number;
  compressionRatio: number;
}

async function transcribe(audioPath: string, opts?: { modelPath?: string }): Promise<AudioSegment[]>;
```

`transcribe()` throws (never returns fabricated output) if the model isn't present at `opts.modelPath`
or the default cache location — call `ensureModel()` first, or pass an explicit `modelPath`. It also
throws if this platform has no bundled binary (see "Status" above).

## Real transcription evidence (captured during Slice B's build)

Ran on this machine (Windows, win32-x64) against
`tests/fixtures/stt-bakeoff/audio/fixture-1-technical-terms-solo.wav` in the memory (cloud) repo — a
real, unmodified, 10-minute AMI Meeting Corpus recording (CC BY 4.0), with the `tiny.en` model, through
the exact `transcribe()` function above with no manual pre-processing of the audio file. **This is a
different capture from the checked-in unit-test fixture**
(`tests/fixtures/real-whisper-cli-output.json`, used by `segment-derive.test.ts`): that fixture is a
gain-boosted **30-second slice** of the same source file with 4 segments and zero non-speech markers
(see its own file header comment); the transcript quoted below is from the **full 10-minute, un-boosted
run** described in this section, which produced 41 raw segments. Same source recording, two different
runs — do not assume one is a subset of the other.

```
transcribe() completed in ~27s -> 41 raw segments -> 5 non-blank segments (36 correctly flagged
[BLANK_AUDIO] and filtered out before ever becoming an AudioSegment, see "Known limitations" below)

"Okay, I'm gonna do this quick, since we're gonna have a shot."
"Okay, so it's not the best day to the world."
"Here we have a map, first point, beginning to meet, same activities."
"Also, I haven't been very, very grateful for myself."
"And I can't remember that's when I used to live my journey, but I think I used to have a head."
```

Compare against the fixture's ground truth
(`tests/fixtures/stt-bakeoff/ground-truth/fixture-1-technical-terms-solo.txt` in the memory repo):
*"...I will make this quick since we don't have much time... it's not the best picture in the world...
Here we have an elephant First point begins with an E... elephants have a very good memory much like
myself and I can't remember back when I used to live back in Nigeria but I think I used to have a pet
elephant..."* — recognizably the same content, transcribed imperfectly by the `tiny` model on real,
unusually quiet audio (see below), not garbage. All 5 kept segments passed FEAT-490's confidence filter
unmodified (`filterLowConfidenceSegments`, 0 dropped).

Ran through astramem-local's own `transcribeHandler` end-to-end too (real add-on linked into
`node_modules`, `audio.mode: 'dry-run'`, `disclosureAcknowledged: true`) — completed without throwing,
persisted nothing (dry-run contract), logged `5 raw segment(s), 5 kept, 0 dropped`.

## Design choices specific to this implementation

- **Peak-normalize before transcribing, per 5-second window, not once across the whole file.** Real
  finding from the E2E proof above: the fixture recording's amplitude is very quiet (~-53 dBFS peak in
  its first 15s) and drifts in level across its 10-minute length. A first attempt normalized once by
  the file's single global peak, which one louder moment elsewhere pinned low enough that most of the
  file was still too quiet for whisper.cpp's own no-speech heuristic — every segment came back
  `[BLANK_AUDIO]`. Per-window normalization (gain capped, silence left untouched) fixed this and is a
  reasonable default for real captured audio in general (headset mics, system audio capture — the
  actual FEAT-489 use case — can drift in level over a session for the same reason a single meeting
  recording did here). See `src/pcm-wav.ts`'s doc comment for the full account.
- **`use_gpu`/GPU backends are a non-issue by construction, not a runtime flag.** The bundled binaries
  are ggml-org's own CPU-only build target — verified directly by inspecting the extracted archive
  during this slice's build: only `ggml-cpu-*.{dll,so}` variants are present, zero CUDA/cublas/Vulkan
  artifacts. `-ng`/`--no-gpu` is still passed on every invocation as belt-and-suspenders, but there is
  no GPU code path in the binary to opt out of in the first place — this is the design doc's "compiled
  out at the CMake level, not a runtime flag" bar, met literally, not approximated.

## Known limitations (transparent, not silently smoothed over)

- **`noSpeechProb` and `avgLogprob`/`compressionRatio` are DERIVED, not read directly off
  whisper.cpp.** Verified against both whisper.cpp's public C API (`include/whisper.h`) and its own CLI
  JSON writer (`examples/cli/cli.cpp`) during this slice's build:
  - `avg_logprob` and `compression_ratio` are OpenAI-Whisper-Python / faster-whisper conventions.
    whisper.cpp's C API does not compute or expose either at all. Reconstructed here from data the CLI
    DOES expose (`-ojf`'s per-token probability, decoded text) — see `src/segment-derive.ts`.
  - `no_speech_prob` DOES have a public getter in whisper.cpp's C API
    (`whisper_full_get_segment_no_speech_prob`), but neither the official CLI's JSON writer nor any
    Node binding checked during this slice's research (`whisper-cpp-node`, `smart-whisper`) surfaces it
    in their output. This add-on derives a coarse proxy instead: whisper.cpp already emits literal
    bracketed markers (`[BLANK_AUDIO]`, `[MUSIC]`, etc.) as segment TEXT when its internal
    `no_speech_prob` exceeded `--no-speech-thold` and suppressed real decoding — a segment whose entire
    text is one of those markers really did fail whisper.cpp's own no-speech check, even though the
    underlying float is never seen. Those marker-only segments are filtered out entirely before
    becoming `AudioSegment` entries (see `isNonSpeechMarkerOnly` in `src/segment-derive.ts`) rather than
    passed through as pseudo-transcript content for FEAT-490's confidence filter to catch — a real
    finding from this slice's E2E proof: whisper.cpp assigns its OWN `[BLANK_AUDIO]` token high
    probability (it's confident that's the right thing to emit), so `avgLogprob` computed from that
    token is NOT low, and FEAT-490's `noSpeechProb > ceiling AND avgLogprob < floor` pairing does not
    reliably fire on it. Filtering upstream (a display marker was never real transcript content) is the
    correct fix, not widening that filter's semantics for a proxy field it was never tuned against.
- **Binary provenance for non-linux-x64 platforms is "ggml-org's own release CI", not "this repo's own
  CI".** Consistent with the design doc's v1 platform-scope fallback and the existing `sqlite-vec`
  precedent in this repo, but worth being explicit: a supply-chain review of this add-on should include
  ggml-org/whisper.cpp's release process, not just this repo's.
- macOS (darwin-arm64/darwin-x64) and win32-ia32 have no pinned binary in v1 — `resolveWhisperCli()`
  returns `null` and `transcribe()` throws the design doc's "not installed for this platform" message,
  never a crash.
- **Per-window peak normalization has an untested-in-production gain discontinuity at window
  boundaries.** Each 5-second window (`src/pcm-wav.ts`) gets its own independently-computed gain, with
  no crossfade — two adjacent windows with very different peaks (the exact shape that motivated
  per-window normalization in the first place) get very different gains, which can step sharply right
  at the boundary, potentially mid-word. `tests/pcm-wav.test.ts` pins down that this step exists and is
  bounded (never exceeds the gain cap or clips), but does not verify whisper.cpp's transcription
  quality is unaffected by it either way — that would need a real-binary A/B run, not yet done.

## Consent (ADR-017)

Enabling audio capture in astramem-local (`audio.mode` != `'off'`) records the voices of everyone in
a captured recording, not just the operator's own. This is default-OFF and requires explicit,
disclosed opt-in in astramem-local — recording or transcribing someone without their knowledge is
restricted or illegal in many places. See `docs/adr/ADR-017-third-party-speaker-consent-model.md` in
the main repo.

## Publishing

`audio-vX.Y.Z` tag namespace, `.github/workflows/audio-publish.yml` — see
`docs/runbooks/release-publish.md` → "Audio add-on release" in the main repo for the full procedure.
