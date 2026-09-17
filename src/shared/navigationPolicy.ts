import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { validateNavigationAddress, validateNavigationUrl } from './types';

/**
 * The resolving half of the ONE navigation URL policy (#1359).
 *
 * `validateNavigationUrl` (shared/types) judges what is written in the URL;
 * this judges where that URL actually points, by resolving the hostname and
 * re-running the same address policy over every answer. Both halves belong to
 * every entry point that loads a URL — browser_navigate, browser_tabs new,
 * browser_open, replay — so this module lives in `shared/` rather than in
 * `main/`: the MCP server's own navigation lanes (the chrome backend navigates
 * a Playwright page directly and never reaches main's RPC handler) have to run
 * the same check, or two tools answer differently for one URL.
 *
 * Node-only: it imports `node:dns` and `node:net`, so the renderer must not
 * import it. The renderer-safe half is `validateNavigationUrl`.
 */

/**
 * Ceiling on the SSRF guard's DNS lookup (#756).
 *
 * `dns.lookup` inherits the OS resolver's own retry schedule, which on Windows
 * can exceed ten seconds before it gives up — longer than any RPC deadline in
 * front of it. An unbounded lookup here meant a slow or dead hostname surfaced
 * to the caller as `RPC timeout: browser.navigate`, naming the transport
 * instead of the actual failure, while the resolver was still grinding.
 *
 * Must stay comfortably below the tightest client deadline that can sit in
 * front of a navigate (the CLI's, see src/cli/client.ts) so the guard always
 * loses the race to its own error rather than to the socket's.
 */
export const DNS_LOOKUP_TIMEOUT_MS = 3_000;

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  /**
   * Set when the refusal is "we could not find out" rather than "we looked and
   * the destination is blocked" — a failed or timed-out DNS lookup.
   *
   * Main stays fail-closed on both: it is the last boundary before the request
   * leaves. The MCP-side preflight refuses only a positive block, so a host
   * that simply does not resolve still reaches the browser and the caller gets
   * Chrome's own `net::ERR_NAME_NOT_RESOLVED` instead of a guard's paraphrase.
   */
  unresolved?: boolean;
}

/**
 * A rejected lookup and a lookup that never answers are the same answer here:
 * we could not prove the destination is safe, so navigation must not proceed.
 * They are reported differently because only one of them is worth retrying.
 */
async function lookupWithTimeout(
  hostname: string,
  timeoutMs: number,
): Promise<{ ok: true; addresses: Array<{ address: string }> } | { ok: false; reason: string }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ ok: false; reason: string }>((resolve) => {
    timer = setTimeout(
      () => resolve({
        ok: false,
        reason:
          `DNS lookup for "${hostname}" did not answer within ${timeoutMs}ms. ` +
          `The address could not be verified as safe, so navigation was refused.`,
      }),
      timeoutMs,
    );
    // Never hold the event loop open on this guard alone.
    timer.unref?.();
  });

  try {
    return await Promise.race([
      lookup(hostname, { all: true, verbatim: true }).then(
        (addresses) => ({ ok: true as const, addresses }),
        (error: unknown) => ({
          ok: false as const,
          reason: `Failed to resolve hostname "${hostname}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        }),
      ),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function validateResolvedAddress(address: string): ValidationResult {
  // One policy, one copy: the ranges live in shared/types next to the literal
  // check, so a resolved 172.16.0.1 and a typed 172.16.0.1 cannot disagree.
  const family = isIP(address);
  if (family === 4 || family === 6) return validateNavigationAddress(address);
  return { valid: false, reason: `Resolved non-IP address: ${address}` };
}

export async function validateResolvedNavigationUrl(url: string): Promise<ValidationResult> {
  const basic = validateNavigationUrl(url);
  if (!basic.valid) return basic;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, reason: 'Invalid URL' };
  }

  const hostname = parsed.hostname;
  if (hostname === 'localhost') {
    return { valid: true };
  }

  if (isIP(hostname)) {
    return validateResolvedAddress(hostname);
  }

  // Bounded: see DNS_LOOKUP_TIMEOUT_MS. The guard must fail with its own
  // reason before the caller's socket deadline fires with a misleading one.
  const resolution = await lookupWithTimeout(hostname, DNS_LOOKUP_TIMEOUT_MS);
  if (!resolution.ok) {
    return { valid: false, reason: resolution.reason, unresolved: true };
  }
  const addresses = resolution.addresses;

  if (addresses.length === 0) {
    return {
      valid: false,
      reason: `Hostname "${hostname}" did not resolve to an IP address`,
      unresolved: true,
    };
  }

  for (const { address } of addresses) {
    const resolved = validateResolvedAddress(address);
    if (!resolved.valid) {
      return { valid: false, reason: `Blocked resolved address ${address}: ${resolved.reason}` };
    }
  }

  return { valid: true };
}
