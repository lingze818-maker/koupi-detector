export const VERSION = '0.1.0';

export const PROTOCOL_VERSION = '2024-11-05';

export const DEFAULTS = {
  roles: ['assistant'],
  window: 24,
  templateThreshold: 4,
  turnThreshold: 10,
  minTurnChars: 30,
  proximity: 80,
  contextTurns: 4,
};

export const ATTRIBUTION_CANDIDATES = [
  'training-data',
  'alignment-preference',
  'prompt-induced',
  'unknown',
];
