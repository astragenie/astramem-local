import { existsSync, readFileSync } from 'node:fs';
import type { CheckResult } from '../types.js';
import { decodeJwtPayload } from '../../providers/llm/codex-subscription.js';

interface CodexAuthFileShape {
  tokens?: { access_token?: string; refresh_token?: string };
}

/**
 * Codex auth probe: checks `~/.codex/auth.json` presence + decodes the
 * access_token's `exp` claim to report remaining validity, WITHOUT making a
 * live network call (the generic LLM chat probe already exercises this
 * provider for a real 1-token call — doctor/probes/llm-chat-probe.ts). This
 * check exists to give an actionable message for the two failure modes the
 * live probe can't distinguish cleanly: "never logged in" vs "logged in but
 * token needs a refresh that hasn't happened yet".
 */
export async function codexAuthProbe(authPath: string): Promise<CheckResult> {
  if (!existsSync(authPath)) {
    return {
      ok: false,
      message: `codex-subscription: no auth.json found at ${authPath}`,
      fix: 'Run `codex login` (requires the Codex CLI — https://developers.openai.com/codex) to sign in with your ChatGPT account.',
    };
  }

  let parsed: CodexAuthFileShape;
  try {
    parsed = JSON.parse(readFileSync(authPath, 'utf8')) as CodexAuthFileShape;
  } catch (err) {
    return {
      ok: false,
      message: `codex-subscription: ${authPath} is not valid JSON (${err instanceof Error ? err.message : err})`,
      fix: 'Run `codex login` again.',
    };
  }

  const accessToken = parsed.tokens?.access_token;
  const refreshToken = parsed.tokens?.refresh_token;
  if (!accessToken || !refreshToken) {
    return {
      ok: false,
      message: `codex-subscription: ${authPath} is missing tokens.access_token/refresh_token`,
      fix: 'Run `codex login` again.',
    };
  }

  const payload = decodeJwtPayload(accessToken);
  const exp = typeof payload?.exp === 'number' ? payload.exp : undefined;
  if (exp === undefined) {
    return { ok: true, message: `codex-subscription: tokens present at ${authPath} (could not decode access_token expiry)` };
  }

  const msLeft = exp * 1000 - Date.now();
  if (msLeft <= 0) {
    return {
      ok: true,
      message: `codex-subscription: access_token expired ${Math.round(Math.abs(msLeft) / 60_000)}m ago — will auto-refresh on next call (refresh_token present)`,
    };
  }
  return { ok: true, message: `codex-subscription: access_token valid for ${Math.round(msLeft / 60_000)}m more` };
}
