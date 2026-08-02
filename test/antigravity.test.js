/**
 * Drives the Antigravity driver against a fake `agy` (see fixtures/fake-agy.mjs),
 * so the whole path — flag building, stream-json parsing, turn queueing, failure
 * reporting — is exercised without the real CLI, credentials or a network.
 *
 * The event shapes the fixture emits come from Google's documentation; nothing
 * here proves the driver against a live agent, only against that documentation.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import { fileURLToPath } from 'node:url';

const WORK = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crc-agy-')));

const { capabilities, createDriver, detect, id, label, resolveExecutable } = await import(
  '../src/agent/drivers/antigravity.js'
);
const { Session } = await import('../src/agent/session.js');

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url));

before(() => {
  // The driver spawns the executable directly, so the fixture has to be one —
  // a checkout that lost the mode bit would otherwise fail with a bare EACCES.
  fs.chmodSync(FAKE_AGY, 0o755);
});

after(() => {
  delete process.env.FAKE_AGY_ARGV_FILE;
  fs.rmSync(WORK, { recursive: true, force: true });
});

/** A started driver plus the events it emitted, in order. */
async function startDriver(overrides = {}) {
  const events = [];
  const driver = createDriver({
    cwd: WORK,
    permissionMode: 'default',
    config: { antigravityExecutable: FAKE_AGY },
    emit: (event) => events.push(event),
    ...overrides,
  });
  await driver.start();
  return { driver, events };
}

/** Wait until `predicate` holds, or fail with what was actually emitted. */
async function waitFor(events, predicate, label, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate(events)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`timed out waiting for ${label}. Events were: ${JSON.stringify(events, null, 2)}`);
}

const ofType = (events, type) => events.filter((e) => e.type === type);
const settled = (events) => events.some((e) => e.type === 'result' || e.type === 'error');

let argvSeq = 0;

/**
 * Point the fixture at a log of its own, and read back only the runs that
 * carried a prompt — `start()` and the model picker spawn agy too, and neither
 * is a turn.
 */
function argvLog() {
  const file = path.join(WORK, `argv-${++argvSeq}.jsonl`);
  process.env.FAKE_AGY_ARGV_FILE = file;
  return () => {
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((argv) => argv.includes('-p'));
  };
}

describe('the driver contract', () => {
  test('exports the identity and capabilities the contract asks for', () => {
    assert.equal(id, 'antigravity');
    assert.equal(typeof label, 'string');
    assert.equal(typeof createDriver, 'function');
    assert.equal(typeof detect, 'function');
    for (const key of ['streaming', 'permissions', 'interrupt', 'models', 'resume', 'images']) {
      assert.equal(typeof capabilities[key], 'boolean', `capabilities.${key} is a boolean`);
    }
  });

  test('permissions is false — the stream cannot carry an answer back', () => {
    assert.equal(capabilities.permissions, false);
    assert.equal(capabilities.images, false, 'agy has no attachment flag');
  });

  test('it is registered as one of the agents this app can drive', async () => {
    const { getDriver } = await import('../src/agent/drivers/index.js');
    assert.equal(getDriver('antigravity')?.id, 'antigravity');
  });

  test('a driver exposes the required methods', async () => {
    const { driver } = await startDriver();
    for (const method of ['start', 'send', 'close', 'interrupt', 'setModel', 'setPermissionMode', 'supportedModels']) {
      assert.equal(typeof driver[method], 'function', `${method}() exists`);
    }
    await driver.close();
  });

  test('requestPermission is never called', async () => {
    const asked = [];
    const { driver, events } = await startDriver({ requestPermission: (...args) => asked.push(args) });
    driver.send('hello');
    await waitFor(events, settled, 'the turn to finish');
    assert.equal(asked.length, 0);
    await driver.close();
  });
});

describe('a turn', () => {
  test('announces readiness before any prompt, since agy runs nothing until then', async () => {
    const { driver, events } = await startDriver();

    const ready = ofType(events, 'ready')[0];
    assert.ok(ready, 'start() announced the driver without spending a turn');
    assert.equal(ready.version, '0.0.0-fake', 'the version comes from `agy --version`');
    assert.match(ready.greeting, /Connected to Antigravity/);
    assert.equal(ofType(events, 'init').length, 0, 'there is no conversation to report yet');
    await driver.close();
  });

  test('parses the stream init into the normalised event', async () => {
    const { driver, events } = await startDriver();
    driver.send('hello');
    await waitFor(events, (e) => ofType(e, 'init').length === 1, 'the conversation to be announced');

    const init = ofType(events, 'init')[0];
    assert.equal(init.sessionId, 'c3b66b04-0000-4000-8000-00000000fa4e');
    assert.equal(init.version, '0.0.0-fake');
    assert.deepEqual(init.tools, ['ask_permission', 'run_command', 'write_to_file']);
    assert.equal(init.cwd, WORK);
    assert.equal(init.permissionMode, 'request-review');
    assert.equal(init.model, 'gemini-3-pro-fake');

    // Review mode cannot be answered from here, and a silent hang is worse than
    // being told so.
    assert.ok(
      ofType(events, 'notice').some((n) => /cannot answer/.test(n.text)),
      'the unanswerable permission mode is called out',
    );
    await driver.close();
  });

  test('streams text deltas in order, and does not repeat them as a whole message', async () => {
    const { driver, events } = await startDriver();
    driver.send('hello');
    await waitFor(events, settled, 'the turn to finish');

    const deltas = ofType(events, 'text_delta').map((e) => e.text);
    assert.deepEqual(deltas, ['Working', ' on ', 'hello', '.'], 'each delta arrived once, in order');
    assert.equal(ofType(events, 'text').length, 0, 'the finished text would double the bubble');
    await driver.close();
  });

  test('a reply that only appears in the result is not lost', async () => {
    // The fixture streams nothing for an empty-prose turn, so the driver falls
    // back to the response on the result line.
    const events = [];
    const driver = createDriver({
      cwd: WORK,
      config: { antigravityExecutable: FAKE_AGY },
      emit: (event) => events.push(event),
    });
    await driver.start();
    // Drop the deltas on the floor to simulate a build that streams nothing.
    const inner = driver.handleStep.bind(driver);
    driver.handleStep = (step) => (step?.step_type === 'agent_response' ? undefined : inner(step));

    driver.send('quiet');
    await waitFor(events, settled, 'the turn to finish');

    assert.deepEqual(ofType(events, 'text').map((e) => e.text), ['Working on quiet.']);
    await driver.close();
  });

  test('maps duration, usage and the missing cost onto the result event', async () => {
    const { driver, events } = await startDriver();
    driver.send('hello');
    await waitFor(events, settled, 'the turn to finish');

    const result = ofType(events, 'result')[0];
    assert.ok(result, 'a result event was emitted');
    assert.equal(result.durationMs, 6880, 'duration_seconds became milliseconds');
    assert.equal(result.numTurns, 1);
    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.costUsd, null, 'agy reports tokens, not money — no invented cost');
    assert.equal(result.usage.input_tokens, 10415);
    assert.equal(result.usage.output_tokens, 657);
    assert.equal(result.usage.thinking_tokens, 616);
    assert.equal(result.usage.cache_read_input_tokens, 8113, 'aliased to the name the app reads');
    assert.equal(result.usage.cache_read_tokens, 8113, 'agy’s own name is kept too');
    assert.ok(!events.some((e) => e.type === 'error'));
    await driver.close();
  });

  test('carries the documented flags onto the command line', async () => {
    const runs = argvLog();
    const { driver, events } = await startDriver({ model: 'gemini-3-pro', permissionMode: 'plan', effort: 'high' });
    driver.send('hello');
    await waitFor(events, settled, 'the turn to finish');

    const argv = runs()[0];
    assert.deepEqual(argv.slice(0, 4), ['-p', 'hello', '--output-format', 'stream-json']);
    assert.ok(argv.includes('--model') && argv[argv.indexOf('--model') + 1] === 'gemini-3-pro');
    assert.ok(argv.includes('--effort') && argv[argv.indexOf('--effort') + 1] === 'high');
    assert.ok(argv.includes('--mode') && argv[argv.indexOf('--mode') + 1] === 'plan');
    await driver.close();
  });

  test('the session folder is put in the workspace, not just used as cwd', async () => {
    // Caught against the real binary: with the folder only as the process cwd,
    // agy wrote into ~/.gemini/antigravity-cli/scratch and said it was done.
    // The screen was honest about it; the file was just somewhere nobody
    // picked. --add-dir is what actually decides where it works.
    const runs = argvLog();
    const { driver, events } = await startDriver({});
    driver.send('hello');
    await waitFor(events, settled, 'the turn to finish');

    const argv = runs()[0];
    const dirs = argv.reduce((all, arg, i) => (arg === '--add-dir' ? [...all, argv[i + 1]] : all), []);
    assert.ok(dirs.includes(WORK), `expected --add-dir ${WORK}, got ${JSON.stringify(dirs)}`);
    await driver.close();
  });

  test('bypassPermissions becomes the skip flag, and default passes no mode', async () => {
    const runs = argvLog();
    const bypass = await startDriver({ permissionMode: 'bypassPermissions' });
    bypass.driver.send('hello');
    await waitFor(bypass.events, settled, 'the turn to finish');
    await bypass.driver.close();

    const argv = runs()[0];
    assert.ok(argv.includes('--dangerously-skip-permissions'));
    assert.ok(!argv.includes('--mode'), 'agy --help documents no "default" mode value');
    assert.equal(ofType(bypass.events, 'init')[0].permissionMode, 'always-proceed');
    assert.equal(ofType(bypass.events, 'notice').length, 0, 'nothing to warn about when nothing asks');
  });

  test('reports tool calls and their results', async () => {
    const { driver, events } = await startDriver();
    driver.send('run TOOL');
    await waitFor(events, settled, 'the turn to finish');

    const tool = ofType(events, 'tool')[0];
    assert.equal(tool.name, 'run_command');
    assert.equal(tool.id, 'call-1');
    assert.deepEqual(tool.input, { command: 'echo run TOOL' });

    const toolResult = ofType(events, 'tool_result')[0];
    assert.equal(toolResult.id, 'call-1');
    assert.equal(toolResult.result, 'run TOOL');
    assert.equal(toolResult.isError, false);
    assert.equal(ofType(events, 'tool').length, 1, 'the running update did not announce it twice');
    await driver.close();
  });

  test('an unknown step_type or event is ignored, not fatal', async () => {
    const { driver, events } = await startDriver();
    driver.send('surprise WEIRD');
    await waitFor(events, settled, 'the turn to finish');

    assert.equal(ofType(events, 'error').length, 0);
    assert.equal(ofType(events, 'text_delta').map((e) => e.text).join(''), 'Working on surprise WEIRD.');
    assert.equal(ofType(events, 'result')[0].status, 'SUCCESS');
    await driver.close();
  });
});

describe('a conversation', () => {
  test('a second turn resumes the first one’s conversation id', async () => {
    const runs = argvLog();
    const { driver, events } = await startDriver();

    driver.send('first');
    await waitFor(events, (e) => ofType(e, 'result').length === 1, 'turn 1');
    driver.send('second');
    await waitFor(events, (e) => ofType(e, 'result').length === 2, 'turn 2');

    const [one, two] = runs();
    assert.ok(!one.includes('--conversation'), 'the first turn opens a new conversation');
    assert.deepEqual(two.slice(0, 2), ['-p', 'second']);
    assert.equal(two[two.indexOf('--conversation') + 1], 'c3b66b04-0000-4000-8000-00000000fa4e');

    assert.equal(ofType(events, 'init').length, 1, 'the second process did not re-announce the conversation');
    assert.equal(
      ofType(events, 'text_delta').map((e) => e.text).join(''),
      'Working on first.Working on second.',
      'both turns streamed their prose',
    );
    await driver.close();
  });

  test('resumeFrom picks up an existing conversation on the first turn', async () => {
    const runs = argvLog();
    const { driver, events } = await startDriver({ resumeFrom: 'aaaaaaaa-0000-4000-8000-00000000beef' });
    driver.send('again');
    await waitFor(events, settled, 'the turn to finish');

    const argv = runs()[0];
    assert.equal(argv[argv.indexOf('--conversation') + 1], 'aaaaaaaa-0000-4000-8000-00000000beef');
    await driver.close();
  });

  test('a second send while busy queues instead of racing a second agy', async () => {
    const argv = argvLog();
    const { driver, events } = await startDriver();

    assert.equal(driver.send('first'), true);
    assert.equal(driver.send('second'), true, 'accepted while the first turn is still running');
    assert.equal(driver.queue.length, 1, 'held, not spawned');

    await waitFor(events, (e) => ofType(e, 'result').length === 2, 'both turns');

    const runs = argv();
    assert.equal(runs.length, 2, 'exactly two processes ran');
    assert.ok(
      runs[1].includes('--conversation'),
      'the queued turn started after the first one taught it the conversation id',
    );
    assert.equal(ofType(events, 'error').length, 0);
    await driver.close();
  });
});

describe('failure reporting', () => {
  test('an ERROR result surfaces as an error, not a result', async () => {
    const { driver, events } = await startDriver();
    driver.send('please FAIL');
    await waitFor(events, settled, 'the turn to finish');

    const error = ofType(events, 'error')[0];
    assert.ok(error, 'an error event was emitted');
    assert.match(error.text, /refused to cooperate/);
    assert.equal(ofType(events, 'result').length, 0, 'a failed turn is not also a result');
    await driver.close();
  });

  test('a crash with no output is reported with what the process said', async () => {
    const { driver, events } = await startDriver();
    driver.send('now CRASH');
    await waitFor(events, settled, 'the failure to surface');

    const error = ofType(events, 'error')[0];
    assert.match(error.text, /agy fell over/);
    assert.equal(ofType(events, 'result').length, 0);
    await driver.close();
  });

  test('unparseable output still ends the turn', async () => {
    const { driver, events } = await startDriver();
    driver.send('emit GARBAGE');
    await waitFor(events, settled, 'the failure to surface');

    assert.match(ofType(events, 'error')[0].text, /without finishing the turn/i);
    await driver.close();
  });

  test('a queued turn still runs after the one before it failed', async () => {
    const { driver, events } = await startDriver();
    driver.send('now CRASH');
    driver.send('recover');
    await waitFor(events, (e) => ofType(e, 'result').length === 1, 'the second turn');

    assert.equal(ofType(events, 'error').length, 1);
    assert.equal(ofType(events, 'text_delta').map((e) => e.text).join(''), 'Working on recover.');
    await driver.close();
  });

  test('a missing binary is reported in this app’s terms, before any prompt', async () => {
    const events = [];
    const driver = createDriver({
      cwd: WORK,
      config: { antigravityExecutable: path.join(WORK, 'no-such-agy') },
      emit: (event) => events.push(event),
    });
    await driver.start();

    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'error');
    assert.equal(events[0].fatal, true, 'a setup failure is not a turn failure');
    assert.match(events[0].text, /antigravityExecutable/, 'names the config key to fix');
    assert.throws(() => driver.send('hello'), /not found at/, 'and refuses prompts it cannot run');
    await driver.close();
  });
});

describe('control', () => {
  test('images are refused rather than silently dropped', async () => {
    const { driver } = await startDriver();
    assert.throws(
      () => driver.send('look', [{ mediaType: 'image/png', data: 'AAAA' }]),
      /cannot take image attachments/,
    );
    await driver.close();
  });

  test('empty prompts are ignored and a closed driver refuses new ones', async () => {
    const { driver } = await startDriver();
    assert.equal(driver.send('   '), false);
    assert.equal(driver.send(''), false);
    await driver.close();
    assert.throws(() => driver.send('too late'), /has ended/);
  });

  test('interrupt stops the running turn and drops what was queued', async () => {
    const { driver, events } = await startDriver();
    driver.send('please HANG');
    driver.send('queued behind it');
    // init now lands at start(), before any process — wait for the real child.
    await waitFor(events, () => driver.child, 'the turn to be under way');

    const pid = driver.child.pid;
    assert.equal(await driver.interrupt(), true);

    assert.equal(driver.queue.length, 0, 'the typed-ahead turn was dropped');
    assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the child is gone');
    assert.equal(ofType(events, 'result').length, 0, 'a killed turn produced no result row');
    assert.equal(ofType(events, 'error').length, 0, 'nor an error — the session announces the stop');
    await driver.close();
  });

  test('close leaves no child process behind', async () => {
    const { driver, events } = await startDriver();
    driver.send('please HANG');
    await waitFor(events, () => driver.child, 'the turn to be under way');

    const pid = driver.child.pid;
    await driver.close();

    assert.equal(driver.child, null);
    assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the child is gone');
  });

  test('the model and permission mode apply to the next turn', async () => {
    const runs = argvLog();
    const { driver, events } = await startDriver();
    driver.setModel('gemini-3-flash');
    driver.setPermissionMode('acceptEdits');
    driver.send('hello');
    await waitFor(events, settled, 'the turn to finish');

    const argv = runs()[0];
    assert.equal(argv[argv.indexOf('--model') + 1], 'gemini-3-flash');
    assert.equal(argv[argv.indexOf('--mode') + 1], 'accept-edits');
    await driver.close();
  });
});

describe('models', () => {
  test('reads slugs out of the plain-text listing', async () => {
    const { driver } = await startDriver();
    const models = await driver.supportedModels();
    assert.deepEqual(models, [
      { id: 'gemini-3-pro-fake', name: 'gemini-3-pro-fake' },
      { id: 'gemini-3-flash-fake', name: 'gemini-3-flash-fake' },
    ]);
    await driver.close();
  });

  test('an error instead of a list yields no models at all', async () => {
    process.env.FAKE_AGY_MODELS_FAIL = '1';
    const { driver } = await startDriver();
    try {
      assert.deepEqual(await driver.supportedModels(), []);
    } finally {
      delete process.env.FAKE_AGY_MODELS_FAIL;
      await driver.close();
    }
  });
});

describe('detect', () => {
  test('reports a well-formed verdict without throwing', async () => {
    const found = await detect();
    assert.equal(typeof found.available, 'boolean');
    assert.ok('path' in found && 'version' in found && 'detail' in found);
    // Whether agy is on this machine is not the driver's business to assert; that
    // it answers cleanly either way is.
    if (found.available) assert.equal(found.path, resolveExecutable({}));
    else assert.match(found.fix, /antigravityExecutable/);
  });

  test('a configured path that is not there reports not-installed and the fix', async () => {
    const missing = await detect({ antigravityExecutable: path.join(WORK, 'no-such-agy') });
    assert.equal(missing.available, false);
    assert.equal(missing.version, null);
    assert.match(missing.detail, /not found at/);
    assert.match(missing.fix, /antigravityExecutable/);
  });

  test('finds and versions the fixture the same way it would the real binary', async () => {
    const found = await detect({ antigravityExecutable: FAKE_AGY });
    assert.equal(found.available, true);
    assert.equal(found.version, '0.0.0-fake');
    assert.equal(found.path, FAKE_AGY);
  });
});

/**
 * The events above only matter if the real session layer renders them properly,
 * so these drive the actual Session — the same class the daemon uses.
 */
describe('through the session layer', () => {
  const sessionConfig = {
    antigravityExecutable: FAKE_AGY,
    maxFeedItems: 500,
    defaultModel: null,
    defaultPermissionMode: 'default',
    permissionTimeoutSec: 5,
  };

  const newSession = () =>
    new Session({ config: sessionConfig, cwd: WORK, driver: 'antigravity' }).start();

  async function waitForFeed(session, predicate, label, timeoutMs = 15000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (predicate(session)) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    const dump = session.feed.items.map((i) => `${i.kind}:${i.text ?? ''}`).join(' | ');
    assert.fail(`timed out waiting for ${label}. Feed was: [${dump}] status=${session.status}`);
  }

  test('the session is usable before the first prompt, and announced once', async () => {
    const session = newSession();
    // agy runs nothing until it has a prompt, so readiness cannot wait for a turn.
    await waitForFeed(session, (s) => s.status === 'idle', 'the session to become usable');
    assert.equal(session.agentSessionId, null, 'no conversation exists yet');

    session.send('hello');
    await waitForFeed(session, (s) => s.feed.items.some((i) => i.kind === 'result'), 'a result');

    const systems = session.feed.items.filter((i) => i.kind === 'system');
    const connected = systems.filter((i) => /Connected to/.test(i.text));
    assert.equal(connected.length, 1, 'readiness and the conversation are one announcement, not two');
    assert.match(connected[0].text, /Connected to Antigravity 0\.0\.0-fake/);
    assert.ok(
      systems.some((i) => /cannot answer/.test(i.text)),
      'and the phone is told it cannot answer agy’s approval prompts',
    );
    await session.close();
  });

  test('a streamed turn lands as exactly one text bubble', async () => {
    const session = newSession();
    session.send('hello');
    await waitForFeed(session, (s) => s.feed.items.some((i) => i.kind === 'result'), 'a result');

    const texts = session.feed.items.filter((i) => i.kind === 'text');
    assert.equal(texts.length, 1, 'the deltas built one bubble, not one per delta');
    assert.equal(texts[0].text, 'Working on hello.');
    assert.equal(texts[0].streaming, false, 'and it was closed out when the turn ended');
    assert.equal(session.agentSessionId, 'c3b66b04-0000-4000-8000-00000000fa4e');
    assert.equal(session.status, 'idle');
    await session.close();
  });

  test('a failed turn becomes a feed error and leaves the session usable', async () => {
    const session = newSession();
    session.send('please FAIL');
    await waitForFeed(session, (s) => s.feed.items.some((i) => i.kind === 'error'), 'an error');

    assert.match(session.lastError, /refused to cooperate/);
    assert.equal(session.status, 'idle', 'a bad turn does not kill the session');
    await session.close();
  });

  test('a tool call becomes one tool row that completes', async () => {
    const session = newSession();
    session.send('please TOOL');
    await waitForFeed(session, (s) => s.feed.items.some((i) => i.kind === 'result'), 'a result');

    const tools = session.feed.items.filter((i) => i.kind === 'tool');
    assert.equal(tools.length, 1);
    assert.equal(tools[0].status, 'done');
    assert.equal(tools[0].result, 'please TOOL');
    await session.close();
  });
});
