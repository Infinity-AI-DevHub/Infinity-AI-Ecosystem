import { isIP } from 'node:net';

type OutboundUrlOptions = {
  allowPrivateHosts?: boolean;
  httpsInProd?: boolean;
};

const PRIVATE_HOSTS = new Set(['localhost', 'localhost.localdomain']);

function ipv4ToNumber(value: string): number {
  return value.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function isPrivateIpv4(value: string): boolean {
  const n = ipv4ToNumber(value);
  return (
    (n >= ipv4ToNumber('10.0.0.0') && n <= ipv4ToNumber('10.255.255.255')) ||
    (n >= ipv4ToNumber('127.0.0.0') && n <= ipv4ToNumber('127.255.255.255')) ||
    (n >= ipv4ToNumber('169.254.0.0') && n <= ipv4ToNumber('169.254.255.255')) ||
    (n >= ipv4ToNumber('172.16.0.0') && n <= ipv4ToNumber('172.31.255.255')) ||
    (n >= ipv4ToNumber('192.168.0.0') && n <= ipv4ToNumber('192.168.255.255')) ||
    value === '0.0.0.0'
  );
}

function isPrivateIpv6(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized === '::1' ||
    normalized === '::' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:')
  );
}

export function isPrivateHost(value: string): boolean {
  let hostname = value;
  try {
    hostname = new URL(value).hostname;
  } catch {
    // Accept bare hostnames for callers that already parsed a URL.
  }
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (PRIVATE_HOSTS.has(host) || host.endsWith('.localhost')) return true;
  const ipVersion = isIP(host);
  if (ipVersion === 4) return isPrivateIpv4(host);
  if (ipVersion === 6) return isPrivateIpv6(host);
  return false;
}

export function validateOutboundUrl(
  name: string,
  value: string,
  options: OutboundUrlOptions = {},
): string {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${name} must use http or https`);
  }
  if (options.httpsInProd && parsed.protocol !== 'https:') {
    throw new Error(`${name} must use https in production`);
  }
  if (!options.allowPrivateHosts && isPrivateHost(parsed.hostname)) {
    throw new Error(`${name} must not point at localhost, link-local, or private network addresses`);
  }
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}
