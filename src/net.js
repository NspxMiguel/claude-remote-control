import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Tailscale hands out addresses from the 100.64.0.0/10 CGNAT range. */
function isTailscaleV4(addr) {
  const [a, b] = addr.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

function isPrivateV4(addr) {
  const [a, b] = addr.split('.').map(Number);
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/**
 * Every address the daemon can realistically be reached on, tagged by kind so
 * the UI can tell "works at home" apart from "works anywhere".
 */
export function localAddresses() {
  const out = [];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const kind = isTailscaleV4(addr.address)
        ? 'tailscale'
        : isPrivateV4(addr.address)
          ? 'lan'
          : 'public';
      out.push({ iface, address: addr.address, kind });
    }
  }
  // Tailscale first, then LAN: the tailnet address is the one worth scanning.
  const rank = { tailscale: 0, lan: 1, public: 2 };
  return out.sort((x, y) => rank[x.kind] - rank[y.kind]);
}

/**
 * Ask the tailscale CLI for the MagicDNS name, which is stabler than the IP.
 * Returns null when tailscale is missing or logged out — never throws.
 */
export async function tailscaleInfo() {
  try {
    const { stdout } = await exec('tailscale', ['status', '--json'], {
      timeout: 4000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const status = JSON.parse(stdout);
    const self = status.Self || {};
    const dnsName = (self.DNSName || '').replace(/\.$/, '');
    return {
      running: status.BackendState === 'Running',
      backendState: status.BackendState || 'Unknown',
      dnsName: dnsName || null,
      ips: self.TailscaleIPs || [],
      magicDNS: Boolean(status.MagicDNSSuffix),
    };
  } catch {
    return null;
  }
}

/**
 * Base URLs for reaching this daemon, best route first.
 *
 * `host` is the address the daemon actually bound to. Listing a LAN or
 * tailnet address while listening only on loopback would hand out addresses
 * that cannot possibly answer — which is exactly the kind of thing you only
 * discover standing in another room holding a phone.
 */
export async function reachableUrls(port, host = '0.0.0.0') {
  const boundToAll = host === '0.0.0.0' || host === '::' || host === '';
  if (!boundToAll) {
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    return {
      urls: loopback
        ? [{ url: `http://localhost:${port}`, kind: 'local', label: 'This machine only' }]
        : [{ url: `http://${host}:${port}`, kind: 'bound', label: `Bound to ${host}` }],
      tailscale: await tailscaleInfo(),
      boundTo: host,
      localOnly: loopback,
    };
  }

  const urls = [];
  const ts = await tailscaleInfo();

  if (ts?.running && ts.dnsName) {
    urls.push({ url: `http://${ts.dnsName}:${port}`, kind: 'tailscale', label: 'Tailscale (anywhere)' });
  }
  for (const addr of localAddresses()) {
    if (addr.kind === 'tailscale' && ts?.running === false) continue;
    urls.push({
      url: `http://${addr.address}:${port}`,
      kind: addr.kind,
      label:
        addr.kind === 'tailscale'
          ? 'Tailscale IP (anywhere)'
          : addr.kind === 'lan'
            ? `LAN via ${addr.iface}`
            : `Public via ${addr.iface}`,
    });
  }
  urls.push({ url: `http://localhost:${port}`, kind: 'local', label: 'This machine' });
  return { urls, tailscale: ts, boundTo: host, localOnly: false };
}
