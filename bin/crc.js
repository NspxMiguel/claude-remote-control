#!/usr/bin/env node
import process from 'node:process';
import QRCode from 'qrcode';

import { CONFIG_PATH, loadConfig, saveConfig } from '../src/config.js';
import { RemoteControlServer } from '../src/server.js';
import { reachableUrls } from '../src/net.js';
import { bold, cyan, dim, green, log, red, setVerbose, yellow } from '../src/log.js';

const HELP = `
${bold('claude-remote-control')} — drive Claude Code from your phone

  ${cyan('crc start')}              Start the daemon (default command)
  ${cyan('crc doctor')} [--json]    Check everything the daemon needs
  ${cyan('crc pair')}               Print a pairing QR code for a new device
  ${cyan('crc status')}             Show config, addresses and Tailscale state
  ${cyan('crc token')} [--rotate]   Show or rotate the master token
  ${cyan('crc devices')} [--revoke <id>]

Options
  --port <n>       Port to listen on (default 8787)
  --host <addr>    Bind address (default 0.0.0.0 — LAN + Tailscale)
  --verbose        Chatty logging
`;

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args.flags[key] = next;
        i++;
      } else {
        args.flags[key] = true;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

async function printQr(text) {
  const qr = await QRCode.toString(text, { type: 'terminal', small: true, errorCorrectionLevel: 'L' });
  console.log(qr);
}

/** Prefer the address that works from anywhere. */
function bestUrl(urls) {
  return (
    urls.find((u) => u.kind === 'tailscale') ||
    urls.find((u) => u.kind === 'lan') ||
    urls[0]
  );
}

async function printAccessInfo(config) {
  const { urls, tailscale, localOnly } = await reachableUrls(config.port, config.host);
  const best = bestUrl(urls);
  const pairUrl = `${best.url}/#token=${config.token}`;

  console.log();
  console.log(bold('  Open on your phone:'));
  console.log();
  await printQr(pairUrl);
  console.log(`  ${green(best.url)}  ${dim(`(${best.label})`)}`);
  console.log();
  console.log(dim('  Other addresses:'));
  for (const u of urls) {
    if (u.url === best.url) continue;
    console.log(`    ${u.url.padEnd(34)} ${dim(u.label)}`);
  }
  console.log();

  if (!tailscale) {
    console.log(`  ${yellow('Tailscale not detected.')} ${dim('Install it to reach this machine from outside your network.')}`);
  } else if (!tailscale.running) {
    console.log(`  ${yellow(`Tailscale is ${tailscale.backendState}.`)} ${dim('Run `tailscale up` to reach this from anywhere.')}`);
  } else {
    console.log(`  ${green('Tailscale up')} ${dim(`as ${tailscale.dnsName || tailscale.ips?.[0] || 'unknown'}`)}`);
  }
  console.log(`  ${dim(`Config: ${CONFIG_PATH}`)}`);
  console.log();
}

async function cmdStart(args) {
  const config = loadConfig();
  if (args.flags.port) config.port = Number(args.flags.port);
  if (args.flags.host) config.host = String(args.flags.host);
  if (args.flags.verbose) setVerbose(true);

  const server = new RemoteControlServer(config);
  try {
    await server.listen();
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(red(`Port ${config.port} is already in use. Pass --port to pick another.`));
      process.exit(1);
    }
    throw err;
  }
  server.startHeartbeat();

  log.info(`${bold('claude-remote-control')} listening on ${config.host}:${config.port}`);
  await printAccessInfo(config);

  // The daemon starts fine without credentials, but every session would fail —
  // better to say so now than from a phone in another room.
  const { checkLogin } = await import('../src/doctor.js');
  const credentials = await checkLogin();
  if (credentials.level === 'bad') {
    console.log(`  ${red('Claude Code is not signed in on this machine.')}`);
    console.log(`  ${dim(credentials.fix)}`);
    console.log(`  ${dim('Run `crc doctor` to re-check.')}\n`);
  }

  if (config.host === '0.0.0.0') {
    console.log(
      dim('  Anyone on your LAN or tailnet who has the token can run commands as you.\n' +
          '  Revoke a lost phone with `crc devices --revoke <id>`.\n'),
    );
  }

  const shutdown = async (signal) => {
    console.log();
    log.info(`${signal} — shutting down`);
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

async function cmdDoctor(args) {
  const config = loadConfig();
  if (args.flags.port) config.port = Number(args.flags.port);

  const { runDoctor } = await import('../src/doctor.js');
  const { results, healthy } = await runDoctor(config);

  // The macOS menu-bar app reads this. `fix` is always present so a client can
  // key off its nullness instead of guessing from the level.
  if (args.flags.json) {
    const checks = results.map(({ level, label, detail, fix }) => ({
      level,
      label,
      detail,
      fix: fix || null,
    }));
    console.log(JSON.stringify({ healthy, checks }, null, 2));
    return healthy;
  }

  console.log();
  for (const result of results) {
    const mark = result.level === 'ok' ? green('✓') : result.level === 'warn' ? yellow('!') : red('✗');
    console.log(`  ${mark} ${bold(result.label.padEnd(17))} ${result.detail}`);
    if (result.fix) console.log(`      ${dim(result.fix)}`);
  }
  console.log();
  console.log(
    healthy
      ? `  ${green('Ready.')} ${dim('Start it with `crc start`.')}`
      : `  ${red('Not ready yet.')} ${dim('Fix the ✗ items above.')}`,
  );
  console.log();
  return healthy;
}

async function cmdPair() {
  const config = loadConfig();
  const { urls } = await reachableUrls(config.port, config.host);
  const best = bestUrl(urls);
  const pairUrl = `${best.url}/#token=${config.token}`;

  console.log();
  console.log(bold('  Scan to pair a device:'));
  console.log();
  await printQr(pairUrl);
  console.log(`  ${dim('or open')} ${green(pairUrl)}`);
  console.log();
  console.log(dim('  The daemon must be running for this link to work (`crc start`).'));
  console.log();
}

async function cmdStatus() {
  const config = loadConfig();
  const { urls, tailscale, localOnly } = await reachableUrls(config.port, config.host);

  console.log();
  console.log(`  ${bold('Config')}      ${CONFIG_PATH}`);
  console.log(`  ${bold('Listen')}      ${config.host}:${config.port}`);
  console.log(`  ${bold('Default cwd')} ${config.defaultCwd}`);
  console.log(`  ${bold('Model')}       ${config.defaultModel}`);
  console.log(`  ${bold('Permissions')} ${config.defaultPermissionMode}`);
  console.log(`  ${bold('Roots')}       ${config.allowedRoots.join(', ')}`);
  console.log(`  ${bold('Devices')}     ${config.devices.length} paired`);
  console.log();
  console.log(`  ${bold('Addresses')}`);
  for (const u of urls) console.log(`    ${u.url.padEnd(34)} ${dim(u.label)}`);
  console.log();
  console.log(
    `  ${bold('Tailscale')}   ${
      tailscale ? (tailscale.running ? green(tailscale.dnsName || 'up') : yellow(tailscale.backendState)) : red('not installed')
    }`,
  );

  const { probeHealth } = await import('../src/doctor.js');
  const health = await probeHealth(config.port);
  console.log(
    `  ${bold('Daemon')}      ${health ? green(`running (v${health.version})`) : dim('not running')}`,
  );
  console.log();
}

async function cmdToken(args) {
  const config = loadConfig();
  if (args.flags.rotate) {
    const { newToken } = await import('../src/config.js');
    config.token = newToken();
    config.devices = [];
    saveConfig(config);
    console.log(`\n  ${green('Master token rotated.')} ${dim('All paired devices were revoked.')}`);
  }
  console.log(`\n  ${config.token}\n`);
}

async function cmdDevices(args) {
  const config = loadConfig();
  if (args.flags.revoke) {
    const id = String(args.flags.revoke);
    const before = config.devices.length;
    config.devices = config.devices.filter((d) => d.id !== id);
    if (config.devices.length === before) {
      console.log(`\n  ${red('No device with that id.')}\n`);
      return;
    }
    saveConfig(config);
    console.log(`\n  ${green('Device revoked.')}\n`);
    return;
  }

  console.log();
  if (!config.devices.length) {
    console.log(`  ${dim('No paired devices yet. Run `crc pair`.')}`);
  }
  for (const device of config.devices) {
    console.log(`  ${bold(device.name)}  ${dim(device.id)}`);
    console.log(`    ${dim(`last seen ${device.lastSeenAt} · ${device.userAgent || 'unknown agent'}`)}`);
  }
  console.log();
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0] || 'start';

try {
  switch (command) {
    case 'start':
      await cmdStart(args);
      break;
    case 'doctor':
      process.exitCode = (await cmdDoctor(args)) ? 0 : 1;
      break;
    case 'pair':
      await cmdPair();
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'token':
      await cmdToken(args);
      break;
    case 'devices':
      await cmdDevices(args);
      break;
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      break;
    default:
      console.error(red(`Unknown command: ${command}`));
      console.log(HELP);
      process.exit(1);
  }
} catch (err) {
  console.error(red(err?.stack || err?.message || String(err)));
  process.exit(1);
}
