// ============================================================
// SSRF guard for outbound webhook delivery.
//
// A webhook URL is attacker-influenced (any account admin with
// `webhooks:manage` can register one) and our server makes the request,
// so an unguarded fetch is a Server-Side Request Forgery primitive: a
// URL pointing at `127.0.0.1`, a cloud metadata IP (`169.254.169.254`),
// or an RFC1918 host would let a caller probe / POST to internal
// services from the app's network.
//
// `isDeliverableUrl` resolves the host and rejects any address that is
// loopback, private, link-local, ULA, or otherwise non-publicly-
// routable. Combined with `redirect: 'manual'` at the call site (so a
// public URL can't 3xx-bounce to an internal one), this blocks the
// common SSRF vectors. It is NOT a defense against DNS rebinding (a
// host that resolves public here but flips to private before connect) —
// that needs pinning the resolved IP into the socket, which fetch
// doesn't expose; documented as a residual risk.
//
// Operator override (WEBHOOK_ALLOWED_HOSTS): a self-hosted deployment
// can legitimately need to reach a sibling service by its internal
// hostname — e.g. two containers on the same Docker network, where the
// host's own public hairpin routing doesn't work and the internal name
// is the only path between them. That's a deployment-topology fact only
// the operator can know, so it's an explicit, operator-set env var, not
// something inferred automatically. Every other destination — anything
// not on the list — is still fully subject to the guard above; this is
// a narrow, exact-match escape hatch, not a general bypass.
// ============================================================

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** True for loopback / private / link-local / reserved IPv4 or IPv6. */
export function isPrivateOrReservedIp(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0) return true; // "this" network
    if (a === 10) return true; // private
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }

  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (v6 === '::1' || v6 === '::') return true; // loopback / unspecified
  if (v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb'))
    return true; // fe80::/10 link-local
  if (v6.startsWith('fc') || v6.startsWith('fd')) return true; // fc00::/7 ULA
  const mapped = v6.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateOrReservedIp(mapped[1]); // IPv4-mapped
  return false;
}

/**
 * True if `rawUrl`'s host resolves only to publicly-routable
 * address(es), WITHOUT considering the WEBHOOK_ALLOWED_HOSTS override.
 * Returns false for a malformed URL, an obvious internal name
 * (`localhost`, `*.local`, `*.internal`), a literal private IP, or a
 * hostname that resolves to any private/reserved address.
 */
async function isPubliclyDeliverable(rawUrl: string): Promise<boolean> {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }

  if (isIP(host)) return !isPrivateOrReservedIp(host);

  const lower = host.toLowerCase();
  if (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal')
  ) {
    return false;
  }

  try {
    const results = await lookup(host, { all: true });
    if (results.length === 0) return false;
    return results.every((r) => !isPrivateOrReservedIp(r.address));
  } catch {
    return false; // unresolvable → not deliverable
  }
}

/**
 * Parse `WEBHOOK_ALLOWED_HOSTS` into a lowercased set of entries. Each
 * entry is either a bare hostname (matches that host on any port) or a
 * `host:port` pair (matches only that exact port). Re-read on every
 * call rather than cached — this only runs on the automation /
 * webhook-delivery path, never per-HTTP-request, so re-parsing a short
 * env var is not worth the staleness risk of caching it.
 */
function parseAllowedHosts(): Set<string> {
  const raw = process.env.WEBHOOK_ALLOWED_HOSTS;
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * True if `rawUrl`'s host is on the operator-configured
 * WEBHOOK_ALLOWED_HOSTS allowlist. Exact match only: a bare hostname
 * entry (`n8n_n8n`) matches that host on any port; a `host:port` entry
 * (`n8n_n8n:5678`) matches only when the URL carries that exact port
 * explicitly (no inference from the scheme's default port). No
 * wildcards, no subdomain or substring matching — an entry for
 * `n8n_n8n` does NOT match `evil-n8n_n8n` or `n8n_n8n.attacker.com`.
 * Empty/unset env var → empty set → always false, i.e. no behavior
 * change from before this existed.
 */
export function isAllowlistedHost(rawUrl: string): boolean {
  const allowed = parseAllowedHosts();
  if (allowed.size === 0) return false;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (allowed.has(host)) return true;
  return url.port !== '' && allowed.has(`${host}:${url.port}`);
}

export interface DeliverabilityResult {
  allowed: boolean;
  /** True when `allowed` is true ONLY because the host matched
   *  WEBHOOK_ALLOWED_HOSTS — the standard private/reserved-address
   *  guard would have refused it on its own. Callers that write to an
   *  audit/execution log should surface this so an operator override
   *  is never silent. */
  viaAllowlist: boolean;
}

/**
 * Full deliverability check, with the reason a URL passed. Use this
 * (over the plain `isDeliverableUrl` below) wherever the caller needs
 * to know whether the allowlist — not the normal guard — is what let a
 * destination through, e.g. to log it.
 */
export async function isDeliverableUrlDetailed(rawUrl: string): Promise<DeliverabilityResult> {
  if (await isPubliclyDeliverable(rawUrl)) return { allowed: true, viaAllowlist: false };
  const allowlisted = isAllowlistedHost(rawUrl);
  return { allowed: allowlisted, viaAllowlist: allowlisted };
}

/**
 * True if `rawUrl` is deliverable — either it passes the standard
 * public-address guard, or its host is on WEBHOOK_ALLOWED_HOSTS. Plain
 * boolean contract, unchanged from before the allowlist existed; use
 * `isDeliverableUrlDetailed` instead when the reason matters.
 */
export async function isDeliverableUrl(rawUrl: string): Promise<boolean> {
  return (await isDeliverableUrlDetailed(rawUrl)).allowed;
}
