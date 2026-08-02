#!/usr/bin/env node
/**
 * A stand-in for Google Antigravity's `agy` binary. It parses the flags the real
 * CLI documents in `agy --help` (1.1.9) and emits the stream-json shapes from
 * Google's published examples: one `init`, N `step_update`, one `result`, each
 * line carrying a top-level `event` discriminator with its payload nested under a
 * key of the same name.
 *
 * The prompt doubles as the script: FAIL, CRASH, GARBAGE, TOOL, WEIRD and HANG
 * each drive a different failure or shape. It is a test fixture, not an agy
 * implementation — the event shapes here are only as right as the docs were.
 *
 * Every exit sets `process.exitCode` and returns rather than calling
 * `process.exit()`, which would truncate a pipe mid-write and make the tests flaky.
 */
import fs from 'node:fs';

const CONVERSATION = 'c3b66b04-0000-4000-8000-00000000fa4e';

/** Mirrors Go's flag package closely enough: `--flag value` and `--flag=value`. */
function parseFlags(args) {
  const flags = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) {
      flags._.push(arg);
      continue;
    }
    const name = arg.replace(/^--?/, '');
    const eq = name.indexOf('=');
    const [key, inline] = eq === -1 ? [name, null] : [name.slice(0, eq), name.slice(eq + 1)];
    if (['dangerously-skip-permissions', 'continue', 'c', 'version', 'sandbox'].includes(key)) {
      flags[key] = true;
      continue;
    }
    const value = inline ?? args[++i];
    if (key === 'add-dir') (flags['add-dir'] ||= []).push(value);
    else flags[key] = value;
  }
  return flags;
}

/**
 * Split every line across two writes, so the driver has to carry a half-line
 * across a chunk boundary the way it will in production.
 */
function emit(object) {
  const json = `${JSON.stringify(object)}\n`;
  const cut = Math.max(1, Math.floor(json.length / 2));
  process.stdout.write(json.slice(0, cut));
  process.stdout.write(json.slice(cut));
}

function main(argv) {
  // Lets a test assert on the flags of every invocation, one JSON array per line.
  if (process.env.FAKE_AGY_ARGV_FILE) {
    try {
      fs.appendFileSync(process.env.FAKE_AGY_ARGV_FILE, `${JSON.stringify(argv)}\n`);
    } catch {
      /* the test will notice the missing file */
    }
  }

  const flags = parseFlags(argv);

  if (flags.version) {
    process.stdout.write('0.0.0-fake\n');
    return 0;
  }

  if (flags._[0] === 'models') {
    if (process.env.FAKE_AGY_MODELS_FAIL) {
      process.stdout.write('Error: Please sign in to view available models.\n');
      return 1;
    }
    // The real `agy models` has no JSON flag, so this is a plain list with a
    // heading and a marker on the current model — exactly what has to be survived.
    process.stdout.write(
      ['Available models', '  gemini-3-pro-fake    Best for hard problems', '* gemini-3-flash-fake  Fast', ''].join('\n'),
    );
    return 0;
  }

  const prompt = flags.p ?? flags.print ?? flags.prompt ?? '';
  const conversationId = flags.conversation || CONVERSATION;

  if (!prompt) {
    process.stderr.write('Error: --print requires a prompt\n');
    return 2;
  }
  if (flags['output-format'] !== 'stream-json') {
    process.stderr.write(`Error: unsupported --output-format ${flags['output-format']}\n`);
    return 2;
  }

  const step = (fields) =>
    emit({ event: 'step_update', step_update: { conversation_id: conversationId, ...fields } });

  if (prompt.includes('CRASH')) {
    process.stderr.write('panic: agy fell over\n');
    return 3;
  }
  if (prompt.includes('GARBAGE')) {
    process.stdout.write('not json at all\n<half a line');
    return 0;
  }

  emit({
    event: 'init',
    conversation_id: conversationId,
    init: {
      cwd: process.cwd(),
      tools: ['ask_permission', 'run_command', 'write_to_file'],
      permission_mode: flags['dangerously-skip-permissions'] ? 'always-proceed' : 'request-review',
      model: flags.model || 'gemini-3-pro-fake',
      agent: 'antigravity',
    },
  });

  step({ step_index: 0, state: 'DONE', step_type: 'user_input' });

  if (prompt.includes('WEIRD')) {
    // Neither of these is in the documented vocabulary; the driver must shrug.
    step({ step_index: 1, state: 'DONE', step_type: 'telemetry_ping', payload: { anything: true } });
    emit({ event: 'heartbeat', heartbeat: { at: 1 } });
  }

  if (prompt.includes('TOOL')) {
    step({
      step_index: 2,
      state: 'RUNNING',
      step_type: 'tool_call',
      tool_info: { tool_call_id: 'call-1', tool_name: 'run_command', input: { command: `echo ${prompt}` } },
    });
    step({
      step_index: 2,
      state: 'DONE',
      step_type: 'tool_call',
      tool_info: { tool_call_id: 'call-1', tool_name: 'run_command', result: prompt },
    });
  }

  // Prose arrives as deltas on one step, then that step goes DONE.
  const chunks = ['Working', ' on ', prompt, '.'];
  chunks.forEach((text, i) => {
    const last = i === chunks.length - 1;
    step({
      step_index: 3,
      state: last ? 'DONE' : 'RUNNING',
      step_type: 'agent_response',
      text_delta: text,
      ...(last ? { duration_seconds: 6.28 } : {}),
    });
  });

  const usage = {
    input_tokens: 10415,
    output_tokens: 657,
    thinking_tokens: 616,
    cache_read_tokens: 8113,
    total_tokens: 11072,
  };

  if (prompt.includes('HANG')) {
    // Stay alive until killed, so a test can interrupt or close a live turn.
    setInterval(() => {}, 1000);
    return 0;
  }

  emit({
    event: 'result',
    conversation_id: conversationId,
    result: prompt.includes('FAIL')
      ? {
          conversation_id: conversationId,
          status: 'ERROR',
          error: 'the model refused to cooperate',
          duration_seconds: 1.5,
          num_turns: 1,
          usage,
        }
      : {
          conversation_id: conversationId,
          status: 'SUCCESS',
          response: `Working on ${prompt}.`,
          duration_seconds: 6.88,
          num_turns: flags.conversation ? 2 : 1,
          usage,
        },
  });
  return 0;
}

process.exitCode = main(process.argv.slice(2));
