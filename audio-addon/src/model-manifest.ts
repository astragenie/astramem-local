/**
 * Pinned GGML model manifest (FEAT-489 Slice B, packaging design pass
 * decision 4 — "Model download UX... checksum-verify (SHA256 against a
 * pinned manifest) after"). One entry per model id this add-on knows how to
 * fetch. `sha256` values below were captured from a REAL download of each
 * file during Slice B's build (not copied from a third-party README) — see
 * the Slice B handoff for the exact command. Re-verify and update this
 * manifest if ggerganov/whisper.cpp ever republishes a model under the same
 * filename with different bytes.
 */
export interface ModelManifestEntry {
  /** Public URL this add-on downloads the model from on first use. */
  url: string;
  /** Expected file size in bytes — shown to the operator before downloading
   *  (design doc: "Show model size before download"). */
  sizeBytes: number;
  /** Expected SHA256 of the downloaded file, lowercase hex. */
  sha256: string;
  /** Filename the model is cached under (see model-cache.ts). */
  filename: string;
}

export const MODEL_MANIFEST: Record<string, ModelManifestEntry> = {
  'tiny.en': {
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin',
    // 77,704,715 bytes — live-verified via HuggingFace's X-Linked-Size
    // header (review 20260715T000328Z). A prior value here (39,206,912)
    // came from a stat read on an early scratch download that turned out to
    // be wrong by ~2x; the sha256 below was always computed from the
    // correct full file, so no download was ever mis-verified — only this
    // displayed size was.
    sizeBytes: 77_704_715,
    sha256: '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f',
    filename: 'ggml-tiny.en.bin',
  },
};

export const DEFAULT_MODEL_ID = 'tiny.en';

export function getModelManifestEntry(modelId: string): ModelManifestEntry {
  const entry = MODEL_MANIFEST[modelId];
  if (!entry) {
    const known = Object.keys(MODEL_MANIFEST).join(', ');
    throw new Error(`Unknown audio model id '${modelId}' — known ids: ${known}`);
  }
  return entry;
}
