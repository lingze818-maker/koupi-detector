import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { compileRuleSet } from './rules.mjs';
import { stripBom } from './text.mjs';

export function readText(file) {
  if (file === '-') return readFileSync(0, 'utf8');
  return readFileSync(file, 'utf8');
}

export function loadRuleSet(file) {
  const raw = stripBom(readFileSync(file, 'utf8'));
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`词表不是合法 JSON：${error.message}`);
  }
  return compileRuleSet(data);
}

export function writeText(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}
