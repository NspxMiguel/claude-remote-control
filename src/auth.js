import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { newToken, saveConfig } from './config.js';
import { log } from './log.js';

const MAX_FAILURES = 10;
const LOCKOUT_MS = 5 * 60 * 1000;
const PAIRING_TTL_MS = 10 * 60 * 1000;

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export class Auth {
  constructor(config) {
    this.config = config;
    /** ip -> { count, until } */
    this.failures = new Map();
    /** code -> { expiresAt } */
    this.pairingCodes = new Map();
  }

  isLockedOut(ip) {
    const entry = this.failures.get(ip);
    if (!entry) return false;
    if (Date.now() > entry.until) {
      this.failures.delete(ip);
      return false;
    }
    return entry.count >= MAX_FAILURES;
  }

  recordFailure(ip) {
    const entry = this.failures.get(ip) || { count: 0, until: 0 };
    entry.count += 1;
    entry.until = Date.now() + LOCKOUT_MS;
    this.failures.set(ip, entry);
    if (entry.count >= MAX_FAILURES) {
      log.warn(`too many bad tokens from ${ip} — locked out for 5 minutes`);
    }
  }

  clearFailures(ip) {
    this.failures.delete(ip);
  }

  /**
   * Resolve a presented secret. The master token proves ownership; device
   * tokens are what the PWA stores after pairing, so they can be revoked one
   * by one without rotating the master token.
   */
  verify(secret) {
    if (!secret) return null;
    if (safeEqual(secret, this.config.token)) return { kind: 'master' };
    for (const device of this.config.devices) {
      if (safeEqual(secret, device.token)) {
        device.lastSeenAt = new Date().toISOString();
        return { kind: 'device', device };
      }
    }
    return null;
  }

  /** Short numeric code so a phone can pair without typing a 43-char token. */
  createPairingCode() {
    const code = String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, '0');
    this.pairingCodes.set(code, { expiresAt: Date.now() + PAIRING_TTL_MS });
    return { code, expiresIn: PAIRING_TTL_MS / 1000 };
  }

  consumePairingCode(code) {
    const entry = this.pairingCodes.get(code);
    if (!entry) return false;
    this.pairingCodes.delete(code);
    return Date.now() <= entry.expiresAt;
  }

  sweepPairingCodes() {
    const now = Date.now();
    for (const [code, entry] of this.pairingCodes) {
      if (now > entry.expiresAt) this.pairingCodes.delete(code);
    }
  }

  registerDevice({ name, userAgent }) {
    const device = {
      id: randomUUID(),
      token: newToken(),
      name: name || 'Unnamed device',
      userAgent: (userAgent || '').slice(0, 200),
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
    this.config.devices.push(device);
    saveConfig(this.config);
    log.info(`paired new device: ${device.name}`);
    return device;
  }

  revokeDevice(id) {
    const before = this.config.devices.length;
    this.config.devices = this.config.devices.filter((d) => d.id !== id);
    const removed = before !== this.config.devices.length;
    if (removed) saveConfig(this.config);
    return removed;
  }

  rotateMasterToken() {
    this.config.token = newToken();
    saveConfig(this.config);
    return this.config.token;
  }
}

/** Pull a bearer token out of the header, or the query string for WebSockets. */
export function extractToken(req, url) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7).trim();
  if (url?.searchParams?.get('token')) return url.searchParams.get('token');
  return null;
}

export function clientIp(req) {
  return req.socket?.remoteAddress || 'unknown';
}
