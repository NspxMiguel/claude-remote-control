/**
 * Getting to this Mac without carrying a VPN in your pocket.
 *
 * Two Tailscale features, one command apart, doing very different things:
 *
 * `tailscale serve`  — HTTPS on the tailnet. Every device that is already on
 *                      the tailnet reaches it. Nothing on the public internet
 *                      does. This is what makes the page a *secure context*,
 *                      which is what the microphone, the QR camera and web
 *                      notifications all refuse to work without.
 *
 * `tailscale funnel` — the same HTTPS URL, published to the whole internet.
 *                      The phone needs no Tailscale at all. It also means
 *                      anyone who learns the address can knock on this daemon,
 *                      so it is never turned on without being asked for.
 *
 * Both need switching on for the tailnet first, which is an account setting on
 * tailscale.com — the CLI answers with the exact link, and that link is passed
 * straight through rather than paraphrased.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from './log.js';

const exec = promisify(execFile);

/** Tailscale's own words when the tailnet has not enabled a feature yet. */
const ENABLE_LINK = /(https:\/\/login\.tailscale\.com\/f\/\S+)/;

async function tailscale(args, timeout = 60_000) {
  try {
    const { stdout, stderr } = await exec('tailscale', args, { timeout });
    return { ok: true, out: `${stdout}${stderr}`.trim() };
  } catch (err) {
    const out = `${err?.stdout || ''}${err?.stderr || ''}${err?.message || ''}`.trim();
    return { ok: false, out };
  }
}

/**
 * Run a `serve`/`funnel` command and stop waiting once it has told us
 * something.
 *
 * `tailscale serve --bg` prints "Serve is not enabled on your tailnet" with the
 * link that fixes it — and then does not exit. Waiting for the process meant
 * waiting for a timeout on the one outcome that has a useful answer, so this
 * watches the output instead and gives up on the process as soon as it has
 * either the link or a success.
 */
function tailscaleWatched(args, timeout = 25_000) {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const child = spawn('tailscale', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      resolve({ ok, out: out.trim() });
    };

    const timer = setTimeout(() => finish(!ENABLE_LINK.test(out)), timeout);
    const read = (chunk) => {
      out += chunk;
      // The one message worth answering immediately.
      if (ENABLE_LINK.test(out)) finish(false);
    };

    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('error', (err) => {
      out += err.message;
      finish(false);
    });
    child.on('close', (code) => finish(code === 0));
  });
}

/**
 * What is in front of the daemon right now.
 *
 * Read from `tailscale serve status --json`, which describes both: a funnel is
 * a serve with the tailnet's whole world allowed in.
 */
export async function publicState(port) {
  const status = await tailscale(['serve', 'status', '--json'], 10_000);
  if (!status.ok) return { available: false, serve: false, funnel: false, url: null, detail: 'Tailscale is not running' };

  let parsed = {};
  try {
    parsed = JSON.parse(status.out || '{}') || {};
  } catch {
    /* "No serve config" is not JSON, and means exactly nothing is set up */
  }

  const host = Object.keys(parsed.Web || {})[0] || null;
  const name = host ? host.replace(/:\d+$/, '') : null;
  const serving = Boolean(
    host &&
      Object.values(parsed.Web[host]?.Handlers || {}).some((h) => String(h.Proxy || '').includes(`:${port}`)),
  );
  const funnel = Boolean(serving && Object.values(parsed.AllowFunnel || {}).some(Boolean));

  return {
    available: true,
    serve: serving,
    funnel,
    url: serving && name ? `https://${name}` : null,
    detail: funnel
      ? 'reachable from anywhere, no Tailscale needed on the phone'
      : serving
        ? 'HTTPS on your tailnet'
        : 'off',
  };
}

/**
 * Put HTTPS in front of the daemon.
 *
 * `open: true` is the funnel — the whole internet. It is a separate argument
 * from a separate button on purpose: the two differ by one word on the command
 * line and by everything else.
 */
export async function enablePublic(port, { open = false } = {}) {
  const command = open ? 'funnel' : 'serve';
  const result = await tailscaleWatched([command, '--bg', '--https=443', `http://127.0.0.1:${port}`]);

  if (!result.ok) {
    const link = result.out.match(ENABLE_LINK)?.[1];
    if (link) {
      throw Object.assign(
        new Error(
          open
            ? 'Funnel is not enabled for your tailnet yet. Turn it on, then press this again.'
            : 'HTTPS is not enabled for your tailnet yet. Turn it on, then press this again.',
        ),
        { status: 409, enableUrl: link },
      );
    }
    throw Object.assign(new Error(result.out.split('\n')[0] || `tailscale ${command} failed`), { status: 500 });
  }

  log.info(`tailscale ${command} is now in front of port ${port}`);
  return publicState(port);
}

/** Take it back down. Off is off for both — a funnel is a serve underneath. */
export async function disablePublic(port) {
  await tailscale(['funnel', '--https=443', 'off'], 30_000);
  await tailscale(['serve', '--https=443', 'off'], 30_000);
  log.info('tailscale serve/funnel switched off');
  return publicState(port);
}
