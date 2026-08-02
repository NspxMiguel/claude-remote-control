const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;

const paint = (code, text) => (COLOR ? `[${code}m${text}[0m` : text);

export const dim = (t) => paint('2', t);
export const bold = (t) => paint('1', t);
export const cyan = (t) => paint('36', t);
export const green = (t) => paint('32', t);
export const yellow = (t) => paint('33', t);
export const red = (t) => paint('31', t);

const stamp = () => dim(new Date().toTimeString().slice(0, 8));

let verbose = process.env.CRC_VERBOSE === '1';

export function setVerbose(on) {
  verbose = on;
}

export const log = {
  info: (...args) => console.log(stamp(), ...args),
  warn: (...args) => console.warn(stamp(), yellow('warn'), ...args),
  error: (...args) => console.error(stamp(), red('error'), ...args),
  debug: (...args) => {
    if (verbose) console.log(stamp(), dim('debug'), ...args);
  },
};
