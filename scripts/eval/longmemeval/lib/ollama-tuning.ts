/**
 * Ollama server throughput tuning — detection + guidance only.
 *
 * IMPORTANT: OLLAMA_NUM_PARALLEL and OLLAMA_KEEP_ALIVE are read by the Ollama
 * SERVER process at its own startup, not by any client (including this
 * harness or the astramemory-local daemons it spawns). This module cannot
 * set them on an already-running Ollama server — Ollama here runs as the
 * user's own long-lived tray app (`ollama app.exe` spawning `ollama.exe`),
 * started independently of this harness, and the harness must not
 * kill/restart a live service the user depends on outside this eval run.
 * What this module *can* do: query current state via /api/version + /api/ps,
 * print concrete setup instructions, and warn if evidence suggests a model
 * is being unloaded/reloaded between calls — which would silently blow
 * through the README's measured "45-60s/session" baseline with idle
 * model-load overhead that baseline does not include.
 */

export interface OllamaLoadedModel {
  name: string;
  expires_at?: string;
  size_vram?: number;
}

export interface OllamaStatus {
  reachable: boolean;
  version?: string;
  loadedModels: OllamaLoadedModel[];
  error?: string;
}

export function resolveOllamaBaseUrl(override?: string): string {
  if (override) return override;
  const fromEnv = process.env.OLLAMA_HOST;
  if (fromEnv) return fromEnv.startsWith('http') ? fromEnv : `http://${fromEnv}`;
  return 'http://127.0.0.1:11434';
}

export async function queryOllamaStatus(baseUrl: string): Promise<OllamaStatus> {
  let verOk = false;
  let version: string | undefined;
  let models: OllamaLoadedModel[] = [];
  let error: string | undefined;
  try {
    const verRes = await fetch(`${baseUrl}/api/version`);
    if (verRes.ok) {
      verOk = true;
      version = ((await verRes.json()) as { version?: string }).version;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  try {
    const psRes = await fetch(`${baseUrl}/api/ps`);
    if (psRes.ok) {
      verOk = true;
      const body = (await psRes.json()) as { models?: OllamaLoadedModel[] };
      models = body.models ?? [];
    }
  } catch (err) {
    error = error ?? (err instanceof Error ? err.message : String(err));
  }
  return { reachable: verOk, version, loadedModels: models, error: verOk ? undefined : error };
}

export function printOllamaTuningGuidance(status: OllamaStatus, baseUrl: string): void {
  console.log(`\n--- Ollama server tuning (${baseUrl}) ---`);
  if (!status.reachable) {
    console.log(`  NOT REACHABLE (${status.error ?? 'unknown error'}).`);
    console.log('  Sharding still spins up N daemons, but they all queue against this one');
    console.log('  Ollama server — if it is down, every shard will just retry/fail the same way.');
  } else {
    console.log(`  version: ${status.version ?? '(unknown)'}`);
    if (status.loadedModels.length === 0) {
      console.log('  loaded models: (none currently resident)');
    } else {
      for (const m of status.loadedModels) {
        console.log(`  loaded: ${m.name}  expires_at=${m.expires_at ?? '?'}  size_vram=${m.size_vram ?? '?'}`);
      }
    }
  }
  console.log('  All shards in this run share this ONE local Ollama server — sharding only');
  console.log("  buys real wall-clock speedup if Ollama can serve concurrent requests. That's");
  console.log('  controlled by two env vars, but they are read by the Ollama SERVER process at');
  console.log("  its own startup — setting them in this harness's shell has NO effect on an");
  console.log('  already-running server:');
  console.log('    OLLAMA_NUM_PARALLEL=2..4   parallel request slots per loaded model (start at');
  console.log('                               2; each slot needs its own VRAM/RAM headroom —');
  console.log('                               raise only if the box has room to spare)');
  console.log('    OLLAMA_KEEP_ALIVE=-1        never unload a model between calls (default is a');
  console.log("                               5-minute idle-unload, which reintroduces model-");
  console.log("                               load latency into every shard's idle gaps and");
  console.log('                               is NOT reflected in the 45-60s/session baseline)');
  console.log('  Windows setup (tray app "ollama app.exe" spawns the "ollama.exe" server):');
  console.log('    1. Quit the Ollama tray app completely (right-click its tray icon > Quit —');
  console.log('       closing just the window leaves the server running with its old env).');
  console.log('    2. Set the vars for your user account (elevated System vars work too):');
  console.log('         setx OLLAMA_NUM_PARALLEL 4');
  console.log('         setx OLLAMA_KEEP_ALIVE -1');
  console.log('       (setx only applies to NEW processes — this is why step 1 matters.)');
  console.log('    3. Relaunch the Ollama tray app so the server process inherits the new env.');
  console.log("    4. Re-run this harness's --dry-run-throughput check, or watch the");
  console.log("       `expires_at` values above stop resetting to a ~5-minute-out timestamp");
  console.log('       after idle gaps between shards.');
}

/** Compares two /api/ps snapshots taken before/after a workload. Returns
 *  names of any model present in `before` but no longer resident in `after`
 *  — evidence it was unloaded (and would have to cold-reload on next use),
 *  which silently adds latency the per-session baseline does not model. */
export function detectPossibleReload(before: OllamaStatus, after: OllamaStatus): string[] {
  const afterNames = new Set(after.loadedModels.map(m => m.name));
  return before.loadedModels.map(m => m.name).filter(name => !afterNames.has(name));
}
