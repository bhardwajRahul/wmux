import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validateResolvedNavigationUrl } from '../navigationPolicy';

// #1359: the resolved check no longer keeps its own copy of the ranges — it
// delegates to the shared policy, so it also reports the shared policy's
// reasons, opt-in hint included.
const PRIVATE_HINT =
  ' — set WMUX_ALLOW_PRIVATE_NETWORK=1 in the environment that launches wmux and the agent to allow private ranges';

const { lookupMock } = vi.hoisted(() => ({
  lookupMock: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({
  lookup: lookupMock,
}));

describe('validateResolvedNavigationUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows public resolved addresses', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

    await expect(validateResolvedNavigationUrl('https://example.com')).resolves.toEqual({ valid: true });
  });

  it('blocks hostnames that resolve to private IPv4 space', async () => {
    lookupMock.mockResolvedValue([{ address: '192.168.1.25', family: 4 }]);

    await expect(validateResolvedNavigationUrl('https://internal.example')).resolves.toEqual({
      valid: false,
      reason: `Blocked resolved address 192.168.1.25: Blocked private IP address (192.168.0.0/16)${PRIVATE_HINT}`,
    });
  });

  it('blocks hostnames that resolve to cloud metadata space', async () => {
    lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);

    await expect(validateResolvedNavigationUrl('https://metadata.example')).resolves.toEqual({
      valid: false,
      reason: 'Blocked resolved address 169.254.169.254: Blocked link-local/cloud metadata address (169.254.0.0/16)',
    });
  });

  it('blocks mixed resolution results when any resolved address is private', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.9', family: 4 },
    ]);

    await expect(validateResolvedNavigationUrl('https://mixed.example')).resolves.toEqual({
      valid: false,
      reason: `Blocked resolved address 10.0.0.9: Blocked private IP address (10.0.0.0/8)${PRIVATE_HINT}`,
    });
  });

  // #1359 — the two copies had drifted: the main-local one allowed every
  // 127.x.x.x address, while the shared literal check allows only 127.0.0.1.
  // One policy now answers both, so a hostname that resolves to a loopback
  // alias gets the same verdict as typing that alias.
  it('applies the shared loopback rule to resolved addresses', async () => {
    lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    await expect(validateResolvedNavigationUrl('https://dev.example')).resolves.toEqual({ valid: true });

    lookupMock.mockResolvedValue([{ address: '127.0.0.2', family: 4 }]);
    await expect(validateResolvedNavigationUrl('https://alias.example')).resolves.toEqual({
      valid: false,
      reason: 'Blocked resolved address 127.0.0.2: Blocked loopback address',
    });
  });

  it('allows localhost without DNS resolution', async () => {
    await expect(validateResolvedNavigationUrl('http://localhost:3000')).resolves.toEqual({ valid: true });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('blocks private IPv6 targets after hostname resolution', async () => {
    lookupMock.mockResolvedValue([{ address: 'fd12:3456:789a::1', family: 6 }]);

    await expect(validateResolvedNavigationUrl('https://ipv6.example')).resolves.toEqual({
      valid: false,
      reason: `Blocked resolved address fd12:3456:789a::1: Blocked private IPv6 address (fc00::/7)${PRIVATE_HINT}`,
    });
  });

  it('blocks IPv6-mapped IPv4 targets after hostname resolution', async () => {
    lookupMock.mockResolvedValue([{ address: '::ffff:169.254.169.254', family: 6 }]);

    await expect(validateResolvedNavigationUrl('https://mapped-ipv4.example')).resolves.toEqual({
      valid: false,
      // The shared policy names the embedded form it unwrapped; the old
      // main-local copy reported only the inner verdict.
      reason:
        'Blocked resolved address ::ffff:169.254.169.254: Blocked IPv4-mapped/compatible IPv6: ' +
        'embedded 169.254.169.254 — Blocked link-local/cloud metadata address (169.254.0.0/16)',
    });
  });

  it('blocks private IPv6 literal URLs before DNS resolution', async () => {
    await expect(validateResolvedNavigationUrl('http://[fd00::1]/')).resolves.toEqual({
      valid: false,
      reason: `Blocked private IPv6 address (fc00::/7)${PRIVATE_HINT}`,
    });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('blocks IPv4-mapped IPv6 literal URLs before DNS resolution', async () => {
    await expect(validateResolvedNavigationUrl('http://[::ffff:169.254.169.254]/')).resolves.toEqual({
      valid: false,
      reason: 'Blocked IPv4-mapped/compatible IPv6: embedded 169.254.169.254 — Blocked link-local/cloud metadata address (169.254.0.0/16)',
    });
    expect(lookupMock).not.toHaveBeenCalled();
  });
});
