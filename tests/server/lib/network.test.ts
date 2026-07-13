import { describe, it, expect } from 'vitest';
import { isLoopbackHost, isLoopbackHostHeader } from '../../../src/server/lib/network.js';

describe('isLoopbackHostHeader', () => {
  it.each([
    '127.0.0.1',
    '127.0.0.1:7777',
    'localhost',
    'localhost:7777',
    'LOCALHOST:7777',
    '::1',
    '[::1]',
    '[::1]:7777',
  ])('%s is a loopback Host header', (h) => {
    expect(isLoopbackHostHeader(h)).toBe(true);
  });

  it.each([
    'evil.com',
    'evil.com:7777',
    '0.0.0.0',
    '0.0.0.0:7777',
    '192.168.1.5',
    '192.168.1.5:7777',
    '',
    'attacker.example.com',
  ])('%s is NOT a loopback Host header', (h) => {
    expect(isLoopbackHostHeader(h)).toBe(false);
  });

  // isLoopbackHost itself stays untouched — this is an additive helper, not
  // a replacement.
  it('does not change isLoopbackHost behavior', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.0.0.1:7777')).toBe(false); // isLoopbackHost never strips ports — by design, it's fed config.network.host, never a Host header
  });
});
