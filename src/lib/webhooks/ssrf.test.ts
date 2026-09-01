import { describe, it, expect, vi, afterEach } from 'vitest';
import { lookup } from 'node:dns/promises';
import {
  isPrivateOrReservedIp,
  isDeliverableUrl,
  isDeliverableUrlDetailed,
  isAllowlistedHost,
} from './ssrf';

// Only the WEBHOOK_ALLOWED_HOSTS tests below need a hostname that
// resolves to a private address (mirroring Docker Swarm's overlay DNS,
// which hands out 10.0.0.0/8 addresses for internal service names).
// Every other test in this file resolves via the IP-literal / known-
// suffix shortcuts and never reaches `lookup`, so mocking it here is
// safe for them — they simply never call it.
vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));

describe('isPrivateOrReservedIp', () => {
  it('flags loopback / private / link-local / CGNAT IPv4', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '0.0.0.0',
    ]) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
  });

  it('allows public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '93.184.216.34']) {
      expect(isPrivateOrReservedIp(ip)).toBe(false);
    }
  });

  it('flags loopback / ULA / link-local IPv6 and IPv4-mapped privates', () => {
    for (const ip of ['::1', 'fe80::1', 'fc00::1', 'fd12::34', '::ffff:127.0.0.1']) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
    expect(isPrivateOrReservedIp('2606:4700:4700::1111')).toBe(false);
  });
});

describe('isDeliverableUrl', () => {
  it('rejects literal private IPs and internal names without DNS', async () => {
    expect(await isDeliverableUrl('https://127.0.0.1/hook')).toBe(false);
    expect(await isDeliverableUrl('https://169.254.169.254/latest/meta-data')).toBe(false);
    expect(await isDeliverableUrl('https://[::1]/hook')).toBe(false);
    expect(await isDeliverableUrl('https://localhost/hook')).toBe(false);
    expect(await isDeliverableUrl('https://foo.internal/hook')).toBe(false);
  });

  it('rejects a malformed URL', async () => {
    expect(await isDeliverableUrl('not a url')).toBe(false);
  });

  it('allows a literal public IP', async () => {
    expect(await isDeliverableUrl('https://8.8.8.8/hook')).toBe(true);
  });
});

describe('isAllowlistedHost', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('matches a bare hostname entry on any port', () => {
    vi.stubEnv('WEBHOOK_ALLOWED_HOSTS', 'n8n_n8n');
    expect(isAllowlistedHost('http://n8n_n8n:5678/webhook/abc')).toBe(true);
    expect(isAllowlistedHost('http://n8n_n8n/webhook/abc')).toBe(true);
    expect(isAllowlistedHost('http://n8n_n8n:9999/webhook/abc')).toBe(true);
  });

  it('matches a host:port entry only on that exact port', () => {
    vi.stubEnv('WEBHOOK_ALLOWED_HOSTS', 'n8n_n8n:5678');
    expect(isAllowlistedHost('http://n8n_n8n:5678/webhook/abc')).toBe(true);
    expect(isAllowlistedHost('http://n8n_n8n:9999/webhook/abc')).toBe(false);
    // No explicit port in the URL at all — a host:port allowlist entry
    // does not infer the scheme's default port.
    expect(isAllowlistedHost('http://n8n_n8n/webhook/abc')).toBe(false);
  });

  it('is case-insensitive on the hostname', () => {
    vi.stubEnv('WEBHOOK_ALLOWED_HOSTS', 'N8N_N8N:5678');
    expect(isAllowlistedHost('http://n8n_n8n:5678/webhook')).toBe(true);
  });

  it('does not match a similar-but-different host — no wildcard or substring matching', () => {
    vi.stubEnv('WEBHOOK_ALLOWED_HOSTS', 'n8n_n8n:5678');
    expect(isAllowlistedHost('http://evil-n8n_n8n:5678/webhook')).toBe(false);
    expect(isAllowlistedHost('http://n8n_n8n.attacker.example:5678/webhook')).toBe(false);
    expect(isAllowlistedHost('http://n8n_n8nx:5678/webhook')).toBe(false);
  });

  it('supports multiple comma-separated entries, trimmed', () => {
    vi.stubEnv('WEBHOOK_ALLOWED_HOSTS', ' n8n_n8n:5678 , other-internal-svc ');
    expect(isAllowlistedHost('http://n8n_n8n:5678/webhook')).toBe(true);
    expect(isAllowlistedHost('http://other-internal-svc/webhook')).toBe(true);
    expect(isAllowlistedHost('http://not-listed/webhook')).toBe(false);
  });

  it('returns false for every host when unset or empty', () => {
    expect(isAllowlistedHost('http://n8n_n8n:5678/webhook')).toBe(false);
    vi.stubEnv('WEBHOOK_ALLOWED_HOSTS', '');
    expect(isAllowlistedHost('http://n8n_n8n:5678/webhook')).toBe(false);
  });
});

describe('isDeliverableUrlDetailed / isDeliverableUrl — WEBHOOK_ALLOWED_HOSTS override', () => {
  // Mirrors the reported production shape: a Docker Swarm service name
  // (`n8n_n8n`) resolves, via the overlay network's embedded DNS, to a
  // private 10.0.0.0/8 address — the guard blocks it exactly like it
  // would block any other private-network destination, unless the
  // operator has explicitly allowlisted this host.
  const DOCKER_INTERNAL_URL = 'http://n8n_n8n:5678/webhook/abc123';

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(lookup).mockReset();
  });

  it('is blocked by default (no WEBHOOK_ALLOWED_HOSTS set)', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '10.0.5.23', family: 4 }] as never);

    expect(await isDeliverableUrlDetailed(DOCKER_INTERNAL_URL)).toEqual({
      allowed: false,
      viaAllowlist: false,
    });
    expect(await isDeliverableUrl(DOCKER_INTERNAL_URL)).toBe(false);
  });

  it('is allowed once the exact host:port is listed, and reports viaAllowlist', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '10.0.5.23', family: 4 }] as never);
    vi.stubEnv('WEBHOOK_ALLOWED_HOSTS', 'n8n_n8n:5678');

    expect(await isDeliverableUrlDetailed(DOCKER_INTERNAL_URL)).toEqual({
      allowed: true,
      viaAllowlist: true,
    });
    expect(await isDeliverableUrl(DOCKER_INTERNAL_URL)).toBe(true);
  });

  it('still blocks a similar-but-different host even with the allowlist set', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '10.0.5.99', family: 4 }] as never);
    vi.stubEnv('WEBHOOK_ALLOWED_HOSTS', 'n8n_n8n:5678');

    const result = await isDeliverableUrlDetailed('http://n8n_n8n_staging:5678/webhook/abc123');
    expect(result).toEqual({ allowed: false, viaAllowlist: false });
  });

  it('an empty allowlist preserves existing behaviour exactly', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '10.0.5.23', family: 4 }] as never);
    vi.stubEnv('WEBHOOK_ALLOWED_HOSTS', '');

    expect(await isDeliverableUrlDetailed(DOCKER_INTERNAL_URL)).toEqual({
      allowed: false,
      viaAllowlist: false,
    });
    // And a genuinely public destination is unaffected either way.
    expect(await isDeliverableUrl('https://8.8.8.8/hook')).toBe(true);
  });
});
