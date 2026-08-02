/**
 * keystore-bounded.ts — timeout boundary around OS credential-store access
 * (keystore-read-timeout, 2026-08-02 incident).
 *
 * INCIDENT: four consecutive daemon boots hung FOREVER, pre-bind, with zero
 * log output — 45+ minutes of unrecoverable downtime. Root cause:
 * `getOrCreateKey` (keystore.ts) calls `@napi-rs/keyring`'s
 * `Entry.getPassword()`/`.setPassword()` — SYNCHRONOUS N-API calls into the
 * OS credential store (Windows Credential Manager / macOS Keychain / Linux
 * libsecret) with NO timeout anywhere in the chain, on the pre-bind boot
 * path, inside the instance-lock mutex. When the OS credential subsystem
 * itself wedges (that day: repeated force-kills of daemons mid-vault-RPC had
 * left the scheduled-task logon session's vault access degraded), the
 * daemon blocks in that native call indefinitely: no port, no log line, no
 * exit, inspector attach refused, and the watchdog (see PR #471) can't help
 * because there is nothing to detect but silence. An interactive-session
 * read of the SAME credential returned in 7ms — this is a genuine HANG, not
 * a slow-but-eventually-answering call.
 *
 * WHY A CHILD PROCESS, NOT A worker_thread: a worker_thread would be
 * cheaper to spawn and keeps the secret in-process, but `Worker.terminate()`
 * cannot preempt a thread that is blocked INSIDE a synchronous native
 * (N-API) call — V8 can only interrupt JS execution at safe points, and the
 * entire failure mode here IS a native call that never returns. A "timed
 * out" worker would leave its underlying OS thread wedged forever — a
 * silent per-hang thread leak, the opposite of "abandon and move on". A
 * child process can be reclaimed by the OS UNCONDITIONALLY
 * (TerminateProcess on win32 / SIGKILL on POSIX) even while blocked deep
 * inside a kernel-mode wait, so `execFileSync`'s own `timeout` option (which
 * does exactly that on expiry) gives a real, bounded abandon: this thread
 * never blocks past `timeoutMs` regardless of what the credential subsystem
 * is doing on the other side.
 *
 * SECURITY — how the secret crosses the process boundary:
 *   - READ (boundedGetPassword): the secret is returned over the child's
 *     stdout, captured by execFileSync straight into this process's memory
 *     (a pipe, never a file, never inherited to a shared/visible fd).
 *   - WRITE (boundedSetPassword): the secret is fed to the child over
 *     STDIN via execFileSync's `input` option — never as a command-line
 *     argument. `service`/`account` (the only argv) are NOT secrets:
 *     `account` is a fixed label ('db-key'/'bearer'/'sync-device-token'),
 *     `service` is a sha256-derived scoped identity string
 *     (keystore.ts's `scopedService`) — neither reveals the credential
 *     value even if another local process's tooling can see this process's
 *     argv.
 *   - `windowsHide: true` on every spawn — this daemon runs windowless on
 *     win32 (see the watchdog-probe-output-capture / D1 slice 6 work); a
 *     child spawn without this would flash a console and regress that.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CHILD_SCRIPT_PATH = join(__dirname, 'keystore-child.js');

/**
 * Bound on how long a single OS credential-store round trip may block
 * before this process gives up on it. Deliberately generous, not tuned: the
 * incident's own evidence (an interactive-session read of the SAME
 * credential returned in 7ms) shows any real answer — including a
 * plausibly slow one under disk/RPC contention — comes back in well under
 * 1s. 5s is headroom, not a budget. If this ever needs tightening or
 * loosening, this is the one constant to change — never disable the bound
 * entirely (see the file header for what "entirely" cost the last time).
 */
export const CREDENTIAL_STORE_TIMEOUT_MS = 5_000;

export type BoundedGetStatus = 'found' | 'not-found' | 'timeout' | 'error';

export interface BoundedGetResult {
  status: BoundedGetStatus;
  value: string | null;
  errorMessage?: string;
}

/**
 * Thrown by `BoundedEntry`/`boundedSetPassword` specifically for the TIMEOUT
 * case — never for a genuine "not found" or a fast credential-store error.
 * Load-bearing distinction, not just an ADR-015 nicety: a plain "the read
 * failed" is safe to treat as "no key exists yet" (the existing, pre-fix
 * tolerance — see keystore.ts's `getOrCreateCredentialStoreKey`), because a
 * fast failure genuinely means the store looked and found nothing. A TIMEOUT
 * means the OPPOSITE — we asked and got no answer in time, so we have NO
 * IDEA whether a key exists. Treating that as "no key exists" would let
 * `getOrCreateCredentialStoreKey` fall through to minting a brand-new
 * random key and OVERWRITING whatever the scoped identity actually holds —
 * destroying a real, already-in-use encryption key on nothing more than a
 * slow read, with no way to recover it afterward (the DB it encrypted
 * becomes permanently unreadable; see serve.ts's `rewrapWrongKeyError` for
 * how loud/fatal that failure is on the NEXT boot, by which point the
 * original key is already gone). Callers that must not risk this (the read
 * paths in keystore.ts) catch this specific type and re-throw it past their
 * own "swallow a fast failure as not-found" logic instead of proceeding.
 */
export class CredentialStoreTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialStoreTimeoutError';
  }
}

// Test-only seams — a real credential-store test would either require a
// genuinely wedged OS keychain (unreproducible) or mutate the developer's
// real one (unacceptable, see keystore.ts's own EntryCtor seam for the same
// reasoning). Tests point childScriptPathOverride at a small fixture script
// that can deterministically return fast, throw, or sleep past the timeout.
let childScriptPathOverride: string | null = null;
export function __setChildScriptPathForTests(path: string | null): void {
  childScriptPathOverride = path;
}

function scriptPath(): string {
  return childScriptPathOverride ?? DEFAULT_CHILD_SCRIPT_PATH;
}

/** True when execFileSync's thrown error indicates ITS OWN `timeout` option
 *  fired (the child was killed for running too long), as opposed to the
 *  child exiting on its own (a genuine credential-store error) — see
 *  ADR-015 rule 4: a timeout must be a distinguishable state, never
 *  collapsed into "not found" or any other domain value. `killed` is the
 *  property Node's own child_process docs name for exactly this signal;
 *  `signal` is checked too as a defensive fallback in case a future Node
 *  version reports the timeout kill differently. */
function isTimeoutError(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
  return e?.killed === true || e?.signal === 'SIGTERM' || e?.signal === 'SIGKILL';
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Reads `service`/`account` from the OS credential store with a hard
 * wall-clock bound, by running the actual `Entry(...).getPassword()` call
 * inside a short-lived child process (keystore-child.ts) instead of this
 * thread. Never throws — every outcome (found / genuinely absent / errored
 * / timed out) is reported in the returned status; ADR-015 rule 4 requires
 * the timeout case specifically be distinguishable from "not found", so
 * callers that only care about "do we have a value" still get a WARN log
 * for the timeout case emitted here, once, regardless of how they treat the
 * returned status afterward.
 */
export function boundedGetPassword(
  service: string,
  account: string,
  timeoutMs: number = CREDENTIAL_STORE_TIMEOUT_MS,
): BoundedGetResult {
  try {
    const out = execFileSync(process.execPath, [scriptPath(), 'get', service, account], {
      timeout: timeoutMs,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(out) as { found: boolean; value: string | null };
    return parsed.found
      ? { status: 'found', value: parsed.value }
      : { status: 'not-found', value: null };
  } catch (err) {
    if (isTimeoutError(err)) {
      console.warn(
        `[astramem-local] WARNING: OS credential store read timed out after ${timeoutMs}ms ` +
        `(service unresponsive) — treating as unavailable for this call. See keystore-bounded.ts ` +
        'for the 2026-08-02 incident this bound exists to close.',
      );
      return { status: 'timeout', value: null, errorMessage: `credential-store read timed out after ${timeoutMs}ms` };
    }
    return { status: 'error', value: null, errorMessage: errMessage(err) };
  }
}

/**
 * Writes `secret` to the OS credential store under `service`/`account`,
 * with the same hard wall-clock bound and out-of-thread execution as
 * boundedGetPassword. Throws on ANY failure (timeout included) — this
 * mirrors `Entry.setPassword()`'s own throw-on-failure contract exactly, so
 * every existing caller's try/catch (keystore.ts's fallback-to-key-file /
 * fallback-to-secrets.env logic) needs no changes to pick up the bound; see
 * this file's header for why reusing the existing fallback path, not
 * inventing a new one, is the point.
 */
export function boundedSetPassword(
  service: string,
  account: string,
  secret: string,
  timeoutMs: number = CREDENTIAL_STORE_TIMEOUT_MS,
): void {
  try {
    execFileSync(process.execPath, [scriptPath(), 'set', service, account], {
      input: secret,
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
  } catch (err) {
    if (isTimeoutError(err)) {
      console.warn(
        `[astramem-local] WARNING: OS credential store write timed out after ${timeoutMs}ms ` +
        '(service unresponsive). See keystore-bounded.ts for the 2026-08-02 incident this bound exists to close.',
      );
      throw new CredentialStoreTimeoutError(`credential-store write timed out after ${timeoutMs}ms`);
    }
    throw err instanceof Error ? err : new Error(errMessage(err));
  }
}

/** Structural subset of `@napi-rs/keyring`'s `Entry` actually used anywhere
 *  in this repo — the interface `BoundedEntry` (and every test fake passed
 *  to keystore.ts's `__setEntryCtorForTests`) needs to satisfy. */
export interface EntryLike {
  getPassword(): string | null;
  setPassword(password: string): void;
}

/**
 * Drop-in replacement for `@napi-rs/keyring`'s `Entry`, backed by the
 * bounded child-process calls above. keystore.ts wires this in as
 * `EntryCtor`'s DEFAULT (see that file) — every existing credential-store
 * call site (db-key, bearer, sync-device-token; scoped AND legacy
 * identities; every doctor check and CLI command built on top) already
 * funnels through `EntryCtor`, so swapping the default here closes the
 * hang hazard everywhere at once, with no per-call-site changes.
 *
 * getPassword() intentionally mirrors the real Entry's own tolerated
 * contract for a FAST failure (return `null` OR throw both mean "no key
 * yet" to every existing caller — see keystore.ts's
 * `getOrCreateCredentialStoreKey` doc comment): 'found' -> the value,
 * 'not-found' -> null, 'error' -> a plain Error (safe for a caller to
 * swallow and treat as "no key yet", exactly like today).
 *
 * 'timeout' is DELIBERATELY DIFFERENT: it throws a `CredentialStoreTimeoutError`
 * specifically (see that class's doc comment for the destructive-overwrite
 * hazard this distinction exists to prevent) rather than a plain `Error`, so
 * a caller that must not risk minting-over-an-unreadable-existing-key
 * (`getOrCreateCredentialStoreKey`'s read paths) can `instanceof`-check and
 * refuse to swallow it, instead of falling through to a write it has no
 * business making under genuine uncertainty.
 */
export class BoundedEntry implements EntryLike {
  constructor(
    private readonly service: string,
    private readonly account: string,
  ) {}

  getPassword(): string | null {
    const result = boundedGetPassword(this.service, this.account);
    if (result.status === 'found') return result.value;
    if (result.status === 'not-found') return null;
    if (result.status === 'timeout') {
      throw new CredentialStoreTimeoutError(result.errorMessage ?? 'credential-store read timed out');
    }
    throw new Error(result.errorMessage ?? 'credential-store read failed');
  }

  setPassword(password: string): void {
    boundedSetPassword(this.service, this.account, password);
  }
}
