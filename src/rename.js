/**
 * Give conversations names you can tell apart.
 *
 * Claude Code writes a title for most of them, but not all — the ones it
 * skipped fall back to the first thing you typed, so a sidebar ends up reading
 * "Create a file named hello.txt containing exactly "hi from my…". This asks a
 * model for a short name for those, in one request rather than one per
 * conversation, and keeps the answer in this app's own config: the transcript
 * belongs to Claude Code, and appending to a file another process owns to
 * change a label is not a trade worth making.
 */
import { credentialEnv } from './agent/credentials.js';
import { log } from './log.js';

const MAX_PREVIEW = 400;
/** One request, so the batch has to stay small enough to answer well. */
export const MAX_BATCH = 24;

const SYSTEM = [
  'You name chat conversations so a person can tell them apart in a sidebar.',
  'Rules: 4 words or fewer. No quotes, no trailing punctuation, no numbering.',
  'Name what the conversation is ABOUT, not what was asked first.',
  'Write each name in the language that conversation is in.',
  'Answer with JSON only: an object mapping each given id to its name.',
].join(' ');

function buildPrompt(entries) {
  const lines = entries.map(
    (entry) =>
      `id: ${entry.id}\ncurrent: ${entry.title || '(none)'}\nopening message: ${String(entry.preview || '')
        .replace(/\s+/g, ' ')
        .slice(0, MAX_PREVIEW)}`,
  );
  return `${SYSTEM}\n\n${lines.join('\n\n')}\n\nJSON only:`;
}

/** Pull the object out of a reply that may be wrapped in prose or a fence. */
export function parseTitles(text) {
  if (typeof text !== 'string') return {};
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return {};
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    if (!parsed || typeof parsed !== 'object') return {};
    const out = {};
    for (const [id, name] of Object.entries(parsed)) {
      if (typeof name !== 'string') continue;
      // Quotes and a full stop arrive in either order — `"Catalogue import".`
      // is as common as `"Catalogue import."` — so peel until nothing changes.
      let clean = name.trim();
      for (let before = null; before !== clean; ) {
        before = clean;
        clean = clean.replace(/^["'`\s]+|["'`\s]+$/g, '').replace(/[.:;,]+$/, '');
      }
      if (clean) out[id] = clean.slice(0, 60);
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Ask for a name for each entry. Returns `{ id: title }`, possibly partial —
 * a conversation the model skipped keeps the name it had.
 */
export async function suggestTitles(config, entries) {
  if (!entries.length) return {};

  const prompt = buildPrompt(entries.slice(0, MAX_BATCH));
  const { detectDrivers } = await import('./agent/drivers/index.js');
  const agents = await detectDrivers(config);
  const claude = agents.find((a) => a.id === 'claude-code');

  // Claude Code first because it answers in one shot with no project loaded.
  // But naming a few conversations is not worth a sign-in someone has not
  // done yet, so any other agent that *is* signed in gets the job instead.
  if (!claude?.available) {
    const other = agents.find((a) => a.available);
    if (!other) {
      throw Object.assign(
        new Error('No agent is signed in, so there is nothing to think of names with.'),
        { status: 409 },
      );
    }
    const text = await askOneShot(config, other.id, prompt);
    const titles = parseTitles(text);
    log.info(`renamed ${Object.keys(titles).length} of ${entries.length} via ${other.id}`);
    return titles;
  }

  return askClaude(config, prompt, entries.length);
}

/**
 * One question, one answer, through whichever agent is available.
 *
 * The driver contract is built for a conversation; this holds it open just
 * long enough for a single reply, and gives up rather than hanging if the
 * agent decides to be chatty.
 */
async function askOneShot(config, driverId, prompt) {
  const { getDriver } = await import('./agent/drivers/index.js');
  const module = getDriver(driverId);
  if (!module) throw new Error(`Unknown agent: ${driverId}`);

  let text = '';
  let settle;
  const done = new Promise((resolve) => {
    settle = resolve;
  });

  const driver = module.createDriver({
    cwd: config.defaultCwd,
    model: null,
    permissionMode: 'default',
    config,
    emit: (event) => {
      if (event.type === 'text') text += event.text;
      else if (event.type === 'text_delta') text += event.text;
      else if (event.type === 'result' || event.type === 'ended') settle();
      else if (event.type === 'error' && event.fatal) settle();
    },
    requestPermission: async () => ({ behavior: 'deny', message: 'Not while naming things.' }),
  });

  const timer = setTimeout(settle, 90_000);
  try {
    await driver.start();
    driver.send(prompt, []);
    await done;
  } finally {
    clearTimeout(timer);
    await driver.close?.();
  }
  return text;
}

async function askClaude(config, prompt, total) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  const run = query({
    prompt,
    options: {
      model: config.defaultModel || undefined,
      maxTurns: 1,
      // Naming a conversation needs no tools and no project context, and
      // loading CLAUDE.md here would drag a whole codebase into a request
      // that only has to write a few words.
      allowedTools: [],
      settingSources: [],
      env: { ...process.env, ...credentialEnv(config, 'claude-code') },
    },
  });

  let text = '';
  for await (const message of run) {
    if (message.type === 'assistant') {
      for (const block of message.message?.content || []) {
        if (block?.type === 'text') text += block.text;
      }
    } else if (message.type === 'result' && (message.subtype === 'error' || message.is_error)) {
      throw new Error(message.error || message.result || 'The agent could not answer.');
    }
  }

  const titles = parseTitles(text);
  log.info(`renamed ${Object.keys(titles).length} of ${total} conversations`);
  return titles;
}
