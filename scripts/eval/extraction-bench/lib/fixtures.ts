/**
 * Gold transcript fixture types + loader.
 *
 * Fixtures live as JSON files under scripts/eval/extraction-bench/fixtures/.
 * Each fixture is a synthetic Claude-Code-style session with a hand-authored
 * gold answer key (the atoms a perfect extractor should produce). See
 * README.md "Adding a gold transcript" for the authoring guide.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(HERE, '..', 'fixtures');

/** Mirrors src/distill/prompts/extract.ts AtomSchema's type enum exactly. */
export type AtomType = 'decision' | 'fact' | 'lesson' | 'command' | 'todo' | 'note' | 'event';

export interface FixtureTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface GoldAtom {
  type: AtomType;
  text: string;
}

export interface GoldFixture {
  id: string;
  title: string;
  /** Free-form difficulty tag — used for grouping in the report, not scored directly. */
  difficulty: string;
  notes?: string;
  turns: FixtureTurn[];
  gold_atoms: GoldAtom[];
}

export function loadFixtures(dir: string = FIXTURES_DIR): GoldFixture[] {
  const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  return files.map(f => {
    const raw = readFileSync(join(dir, f), 'utf8');
    const parsed = JSON.parse(raw) as GoldFixture;
    if (!parsed.id || !Array.isArray(parsed.turns) || !Array.isArray(parsed.gold_atoms)) {
      throw new Error(`fixture ${f}: missing required fields (id, turns[], gold_atoms[])`);
    }
    return parsed;
  });
}
