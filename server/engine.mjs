import { randomBytes, randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TRACKS = JSON.parse(readFileSync(new URL('../data/songs.json', import.meta.url), 'utf8'));
const DIGITS = '0123456789';
const KANA = Array.from('アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンァィゥェォッャュョーガギグゲゴザジズゼゾダヂヅデドバビブベボパピプペポ');
const HIRA = Array.from('あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをんぁぃぅぇぉっゃゅょがぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽ');
const OTHER = Array.from('恋夜星空花夏青春君僕海夢雨光風愛道声音明日今日世界一小大白赤新島歩見上流涙奏楽天体観測本来');
export const DEFAULT_HIT = { allowZero: true, turnSeconds: 30, hints: false };
export const DEFAULT_QUIZ = { target: 5, points: 1, penalty: -1, wrongMode: 'resume', allowRepeat: false, speedMs: 250, answerSeconds: 12, difficulty: 'mix', era: 'mix', inputMethod: 'choices' };
export function normalizeAnswer(x) { return String(x).normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').replace(/[ぁ-ゖ]/gu, c => String.fromCharCode(c.charCodeAt(0) + 0x60)).toLocaleLowerCase('ja-JP'); }
export function graphemes(s) { return [...new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(s)].map(x => x.segment); }
export function hitBlow(secret, guess) { let hits = 0, blows = 0; for (let i = 0; i < 3; i++) { if (secret[i] === guess[i]) hits++; else if (secret.includes(guess[i])) blows++; } return { hits, blows }; }
export function validNumber(s, allowZero) { return typeof s === 'string' && /^[0-9]{3}$/.test(s) && new Set(s).size === 3 && (allowZero || s[0] !== '0'); }
export function sanitiseConfig(type, input = {}) {
  const i = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const enumValue = (field, values, def) => values.includes(i[field]) ? i[field] : def;
  const int = (field, min, max, def) => Number.isInteger(i[field]) && i[field] >= min && i[field] <= max ? i[field] : def;
  return type === 'hit' ? {
    allowZero: i.allowZero !== false,
    turnSeconds: enumValue('turnSeconds', [0,10,15,20,30,45,60,90], 30),
    hints: i.hints === true
  } : {
    target: int('target', 1, 100, 5), points: enumValue('points', [1, 2], 1),
    penalty: enumValue('penalty', [0, -1, -2], -1),
    wrongMode: enumValue('wrongMode', ['opponent','resume','end'], 'resume'),
    allowRepeat: i.allowRepeat === true,
    speedMs: int('speedMs', 100, 1500, 250),
    answerSeconds: int('answerSeconds', 3, 60, 12),
    difficulty: enumValue('difficulty', ['mix','easy','medium','hard'], 'mix'),
    era: enumValue('era', ['mix','昭和','平成','令和'], 'mix'),
    inputMethod: enumValue('inputMethod', ['choices','keyboard'], 'choices')
  };
}
export function makeOptions(correct, titles = []) {
  const symbol = graphemes(correct)[0];
  let pool = /[ぁ-ゖ]/u.test(symbol) ? HIRA : /[ァ-ヿー]/u.test(symbol) ? KANA : /[0-9]/.test(symbol) ? [...DIGITS] : /[a-z]/.test(symbol) ? [...'abcdefghijklmnopqrstuvwxyz'] : /[A-Z]/.test(symbol) ? [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'] : OTHER;
  const others = titles.flatMap(x => graphemes(x)).filter(c => c !== symbol && (/^[ぁ-ゖ]$/u.test(c) === /^[ぁ-ゖ]$/u.test(symbol)) && (/^[ァ-ヿー]$/u.test(c) === /^[ァ-ヿー]$/u.test(symbol)) && (/^[0-9]$/.test(c) === /^[0-9]$/.test(symbol)) && (/^[a-zA-Z]$/.test(c) === /^[a-zA-Z]$/.test(symbol)));
  const picked = new Set([symbol]);
  const shuffled = [...others, ...pool].sort(() => Math.random() - .5);
  for (const c of shuffled) { if (picked.size >= 4) break; if (c !== symbol) picked.add(c); }
  while (picked.size < 4) picked.add(String(picked.size));
  return [...picked].sort(() => Math.random() - .5);
}
export function makeRoomCode(existing) {
  let code;
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  do { code = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join(''); } while (existing.has(code));
  return code;
}
export function randomToken() { return randomBytes(20).toString('hex'); }
export function filteredTracks(config) {
  const all = TRACKS.filter(x => (config.difficulty === 'mix' || x.difficulty === config.difficulty) && (config.era === 'mix' || x.era === config.era));
  for (let i = all.length - 1; i > 0; i--) { const j = randomInt(i + 1); [all[i], all[j]] = [all[j], all[i]]; }
  return all;
}
