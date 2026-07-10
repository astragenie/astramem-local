import { describe, it, expect } from 'vitest';
import { porterStem } from './porter-stemmer.js';

/** 72 (word, expected-stem) pairs sampled every 331st entry (by index) from
 *  the Porter algorithm author's own reference corpus (voc.txt/output.txt,
 *  23,531 pairs, https://tartarus.org/martin/PorterStemmer/, fetched
 *  2026-07-10) -- a deterministic stride sample across the whole alphabet,
 *  not cherry-picked. The full corpus run scored 99.93% exact match (16/23531
 *  mismatches, see porter-stemmer.ts's header); this stride happens to avoid
 *  all 16 known mismatches, so every pair here is expected to pass exactly. */
const REFERENCE_PAIRS: Array<[string, string]> = [
  ['a', 'a'], ['advent', 'advent'], ['amend', 'amend'], ['arithmetic', 'arithmet'],
  ['awakes', 'awak'], ['beated', 'beat'], ['betwixt', 'betwixt'], ['bonfires', 'bonfir'],
  ['brows', 'brow'], ['capocchia', 'capocchia'], ['chantry', 'chantri'], ['clamb', 'clamb'],
  ['commenced', 'commenc'], ['conserved', 'conserv'], ['countercheck', 'countercheck'],
  ['cunningly', 'cunningli'], ['declining', 'declin'], ['detests', 'detest'],
  ['disliken', 'disliken'], ['doves', 'dove'], ['edicts', 'edict'], ['enormous', 'enorm'],
  ['eterniz', 'eterniz'], ['faint', 'faint'], ['fiery', 'fieri'], ['footfall', 'footfal'],
  ['frolic', 'frolic'], ['giantess', 'giantess'], ['grating', 'grate'], ['hapless', 'hapless'],
  ['heure', 'heur'], ['humbler', 'humbler'], ['incite', 'incit'], ['intellectual', 'intellectu'],
  ['joyful', 'joy'], ['langues', 'langu'], ['lifted', 'lift'], ['lull', 'lull'],
  ['marullus', 'marullu'], ['mildew', 'mildew'], ['moping', 'mope'], ['necessitied', 'necess'],
  ['obeys', 'obei'], ['outlaw', 'outlaw'], ['parlous', 'parlou'], ['periods', 'period'],
  ['plainly', 'plainli'], ['poultney', 'poultnei'], ['procreant', 'procreant'], ['purse', 'purs'],
  ['raving', 'rave'], ['removed', 'remov'], ['ribald', 'ribald'], ['rust', 'rust'],
  ['scored', 'score'], ['shadowy', 'shadowi'], ['silk', 'silk'], ['snoring', 'snore'],
  ['spleens', 'spleen'], ['stomaching', 'stomach'], ['sulphurous', 'sulphur'], ['tainted', 'taint'],
  ['thievery', 'thieveri'], ['tortured', 'tortur'], ['truths', 'truth'], ['undertaker', 'undertak'],
  ['unregarded', 'unregard'], ['vacancy', 'vacanc'], ['visard', 'visard'], ['wearily', 'wearili'],
  ['wishful', 'wish'], ['younger', 'younger'],
];

describe('porterStem', () => {
  it('matches the reference corpus on a deterministic stride sample', () => {
    for (const [word, expected] of REFERENCE_PAIRS) {
      expect(porterStem(word), `stem(${word})`).toBe(expected);
    }
  });

  it('lowercases input', () => {
    expect(porterStem('RUNNING')).toBe(porterStem('running'));
  });

  it('leaves short words (<=2 chars) unchanged', () => {
    expect(porterStem('is')).toBe('is');
    expect(porterStem('a')).toBe('a');
  });
});
