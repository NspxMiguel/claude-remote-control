/**
 * How hard the agent should think.
 *
 * The SDK calls this the effort level and accepts five: low, medium, high,
 * xhigh, max. There is no "ultra" — ultracode is a different thing entirely
 * (orchestrating several agents), not a knob on one.
 *
 * Not every model honours every level: xhigh and max fall back to high on
 * models that do not implement them, which the SDK does silently. Antigravity
 * takes only the first three, so its driver clamps.
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

export const EFFORT_LABELS = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

/** The most an agent will accept, so a session never dies on an unknown value. */
export function clampEffort(effort, { maxLevel = 'max' } = {}) {
  if (!effort) return null;
  const wanted = EFFORT_LEVELS.indexOf(effort);
  if (wanted === -1) return null;
  const ceiling = EFFORT_LEVELS.indexOf(maxLevel);
  return EFFORT_LEVELS[Math.min(wanted, ceiling === -1 ? EFFORT_LEVELS.length - 1 : ceiling)];
}

export const isEffort = (value) => EFFORT_LEVELS.includes(value);
