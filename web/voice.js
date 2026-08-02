/**
 * Talking to the app, and the app talking back.
 *
 * Both directions are WebKit-native, which matters because the phone in
 * question is an iPhone: `webkitSpeechRecognition` for dictation and
 * `speechSynthesis` for reading a reply out loud — probed on iOS 26.5, where
 * they report true and 68 voices. Nothing is uploaded anywhere; the recognition
 * that ships in the browser is the recognition used.
 *
 * The one hard limit is the same as the camera's: dictation needs a secure
 * context, so over plain `http://10.0.0.x` the button explains itself instead
 * of failing silently.
 */

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export const dictationSupported = () => Boolean(Recognition) && window.isSecureContext;

/** Why dictation is not on offer, in words worth putting on screen. */
export function dictationObstacle() {
  if (dictationSupported()) return null;
  if (!Recognition) return 'This browser has no dictation built in.';
  return 'Dictation needs a secure connection. Over plain HTTP the browser will not open the microphone.';
}

/**
 * Start listening. `onText` gets the transcript so far — interim results
 * included, because watching the words appear is what makes it feel like it is
 * working. Returns a stop function.
 */
export function startDictation({ onText, onEnd, onError, lang } = {}) {
  const recognition = new Recognition();
  recognition.lang = lang || navigator.language || 'en-US';
  recognition.continuous = true;
  recognition.interimResults = true;

  let finalText = '';

  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      if (result.isFinal) finalText += result[0].transcript;
      else interim += result[0].transcript;
    }
    onText?.((finalText + interim).trim(), { final: finalText.trim() });
  };

  recognition.onerror = (event) => {
    // `no-speech` and `aborted` are the ordinary ways a dictation ends, not
    // faults worth showing anyone.
    if (event.error === 'no-speech' || event.error === 'aborted') return;
    onError?.(
      event.error === 'not-allowed'
        ? 'Microphone access was refused.'
        : `Dictation stopped: ${event.error}`,
    );
  };

  recognition.onend = () => onEnd?.(finalText.trim());

  recognition.start();
  return () => {
    try {
      recognition.stop();
    } catch {
      /* already stopped */
    }
  };
}

// ---------------------------------------------------------------------------
// Reading a reply out loud
// ---------------------------------------------------------------------------

export const narrationSupported = () => 'speechSynthesis' in window;

/**
 * Strip what nobody wants read aloud.
 *
 * A spoken code block is unbearable — thirty seconds of "open brace const x
 * equals" — and the same goes for paths, URLs and long hex. The shape of the
 * sentence is kept: each removal leaves a short spoken placeholder so the
 * reply still makes sense without it.
 */
export function speakableText(markdown) {
  let text = String(markdown || '');

  text = text.replace(/```[\s\S]*?```/g, ' (code block) ');
  text = text.replace(/~~~[\s\S]*?~~~/g, ' (code block) ');
  // Inline code: short spans are usually a word worth saying (a flag, a name);
  // long ones are a command line, and get summarised instead.
  text = text.replace(/`([^`\n]+)`/g, (_, inner) => (inner.length <= 24 ? inner : ' (command) '));

  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' (image) ');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/https?:\/\/\S+/g, ' (link) ');
  // A path with two or more segments; a bare word with a slash stays.
  text = text.replace(/(?:[~.]?\/[\w.-]+){2,}\/?/g, ' (a path) ');

  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  text = text.replace(/^\s{0,3}>\s?/gm, '');
  text = text.replace(/^\s*[-*+]\s+/gm, '');
  text = text.replace(/^\s*\d+\.\s+/gm, '');
  text = text.replace(/^\s*\|.*\|\s*$/gm, ' (a table) ');
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1');
  text = text.replace(/^-{3,}$/gm, '');

  // Collapse the placeholders we just scattered, so a reply that was mostly
  // code does not become "code block code block code block".
  text = text.replace(/(\s*\((?:code block|command|a path|link|image|a table)\)\s*)+/g, ' $1 ');
  return text.replace(/\s+/g, ' ').trim();
}

let voicePromise = null;

/** Voices arrive asynchronously on WebKit: empty at load, 68 a moment later. */
function voicesReady() {
  voicePromise ||= new Promise((resolve) => {
    const existing = speechSynthesis.getVoices();
    if (existing.length) return resolve(existing);
    const timer = setTimeout(() => resolve(speechSynthesis.getVoices()), 1500);
    speechSynthesis.addEventListener(
      'voiceschanged',
      () => {
        clearTimeout(timer);
        resolve(speechSynthesis.getVoices());
      },
      { once: true },
    );
    return undefined;
  });
  return voicePromise;
}

/** The best match for the page's language, or whatever the system prefers. */
async function pickVoice(lang) {
  const voices = await voicesReady();
  if (!voices.length) return null;
  const want = (lang || navigator.language || 'en-US').toLowerCase();
  return (
    voices.find((v) => v.lang?.toLowerCase() === want) ||
    voices.find((v) => v.lang?.toLowerCase().startsWith(want.slice(0, 2))) ||
    voices.find((v) => v.default) ||
    voices[0]
  );
}

export const isNarrating = () => narrationSupported() && speechSynthesis.speaking;

export function stopNarration() {
  if (narrationSupported()) speechSynthesis.cancel();
}

/**
 * Read a reply. Long text is split on sentence boundaries: WebKit truncates
 * very long utterances, and short ones also mean `cancel()` stops promptly
 * when you press it again.
 */
export async function narrate(markdown, { lang, onDone } = {}) {
  if (!narrationSupported()) return false;
  const text = speakableText(markdown);
  if (!text) return false;

  stopNarration();
  const voice = await pickVoice(lang);

  const chunks = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
  const batched = [];
  for (const chunk of chunks) {
    const last = batched[batched.length - 1];
    if (last && last.length + chunk.length < 220) batched[batched.length - 1] = last + chunk;
    else batched.push(chunk);
  }

  batched.forEach((part, index) => {
    const utterance = new SpeechSynthesisUtterance(part.trim());
    if (voice) utterance.voice = voice;
    utterance.lang = voice?.lang || lang || navigator.language || 'en-US';
    utterance.rate = 1.02;
    if (index === batched.length - 1) utterance.onend = () => onDone?.();
    speechSynthesis.speak(utterance);
  });
  return true;
}
