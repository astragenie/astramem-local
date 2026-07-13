import { describe, it, expect } from 'vitest';
import { originIsLoopback } from '../../../src/server/lib/origin-guard.js';

// The CSRF guard behind auth.devNoAuth (src/server/app.ts + dashboard-auth.ts).
// A urlencoded form POST is a CORS simple request, so no preflight protects the
// daemon; Origin is the only header that reflects the CALLING page.
describe('originIsLoopback', () => {
  it('accepts genuine loopback origins, with and without a port', () => {
    expect(originIsLoopback('http://127.0.0.1:7777')).toBe(true);
    expect(originIsLoopback('http://127.0.0.1')).toBe(true);
    expect(originIsLoopback('http://localhost:7777')).toBe(true);
    expect(originIsLoopback('https://localhost')).toBe(true);
  });

  it('accepts IPv6 loopback origins — URL.hostname keeps the brackets, isLoopbackHost expects them stripped', () => {
    expect(originIsLoopback('http://[::1]:7777')).toBe(true);
    expect(originIsLoopback('http://[::1]')).toBe(true);
  });

  it('rejects hostnames that merely embed a loopback name', () => {
    expect(originIsLoopback('http://localhost.evil.com')).toBe(false);
    expect(originIsLoopback('http://127.0.0.1.evil.com')).toBe(false);
    expect(originIsLoopback('https://evil.com/127.0.0.1')).toBe(false);
    expect(originIsLoopback('http://evil.com')).toBe(false);
  });

  it('rejects opaque and malformed origins rather than throwing', () => {
    // A sandboxed iframe / redirected cross-origin request sends the literal
    // string "null" — it must never be read as loopback.
    expect(originIsLoopback('null')).toBe(false);
    expect(originIsLoopback('')).toBe(false);
    expect(originIsLoopback('not a url')).toBe(false);
  });

  it('normalizes obfuscated loopback IP spellings via the WHATWG URL parser', () => {
    // Node's URL parser canonicalizes these to 127.0.0.1 — they are the real
    // loopback, so accepting them is correct, not a bypass.
    expect(originIsLoopback('http://0x7f000001')).toBe(true);
    expect(originIsLoopback('http://2130706433')).toBe(true);
    expect(originIsLoopback('http://127.1')).toBe(true);
  });
});
