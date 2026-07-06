#!/usr/bin/env node
/**
 * contracts/generate-types.mjs — generates TypeScript types from every JSON
 * Schema under contracts/schemas/ (draft 2020-12) into contracts/types/.
 *
 * Why: the canonical contract lives as language-neutral JSON Schema (so the
 * .NET cloud repo can consume the exact same files — see README "Cloud
 * consumption"). TypeScript consumers (astramem-local itself, astramem-plugin)
 * want compile-time types, not a runtime ajv validator, on the hot path. This
 * script is the codegen bridge: JSON Schema (source of truth) -> generated .d.ts
 * (never hand-edited). Regenerated in CI; drift = a failing diff.
 *
 * Output: one <name>.v<N>.d.ts per schema + an index.d.ts barrel. The barrel
 * also re-exports the raw JSON schemas (via package exports) so callers can
 * still reach the ajv-validatable source when they need runtime validation.
 *
 * Dep: json-schema-to-typescript (root devDependency). Plain Node ESM, no TS
 * build step — mirrors validate.mjs so the same `node contracts/*.mjs` CI
 * invocation covers both.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { compile } from 'json-schema-to-typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = join(__dirname, 'schemas');
const TYPES_DIR = join(__dirname, 'types');

/** "atom.v1.schema.json" -> "AtomV1" type name. */
function typeNameForSchema(schemaFileName) {
  const m = schemaFileName.match(/^(.+)\.v(\d+)\.schema\.json$/);
  if (!m) throw new Error(`schema file does not match "<name>.v<N>.schema.json": ${schemaFileName}`);
  const parts = m[1].split(/[-.]/).map((p) => p.charAt(0).toUpperCase() + p.slice(1));
  return `${parts.join('')}V${m[2]}`;
}

/** "atom.v1.schema.json" -> "atom.v1" output basename. */
function outBaseForSchema(schemaFileName) {
  return schemaFileName.replace(/\.schema\.json$/, '');
}

async function main() {
  mkdirSync(TYPES_DIR, { recursive: true });

  const schemaFiles = readdirSync(SCHEMAS_DIR)
    .filter((f) => f.endsWith('.schema.json'))
    .sort();

  if (schemaFiles.length === 0) {
    console.error('FAIL: no schema files found under contracts/schemas/');
    process.exit(1);
  }

  const barrelExports = [];

  for (const file of schemaFiles) {
    const schema = JSON.parse(readFileSync(join(SCHEMAS_DIR, file), 'utf-8'));
    const typeName = typeNameForSchema(file);
    const outBase = outBaseForSchema(file);

    // json-schema-to-typescript names the root interface from `title` when
    // present. Override it to our deterministic <Name>V<N> so the generated
    // export name matches what the barrel re-exports. The human-readable title
    // survives in the schema's own `description` (emitted as the JSDoc block).
    schema.title = typeName;

    const ts = await compile(schema, typeName, {
      bannerComment:
        `/* eslint-disable */\n/**\n * GENERATED — do not edit. Source: contracts/schemas/${file}\n` +
        ` * Regenerate: node contracts/generate-types.mjs\n */`,
      additionalProperties: false,
      style: { singleQuote: true },
    });

    writeFileSync(join(TYPES_DIR, `${outBase}.d.ts`), ts, 'utf-8');
    barrelExports.push(`export type { ${typeName} } from './${outBase}.js';`);
    console.log(`  generated types/${outBase}.d.ts  (${typeName})`);
  }

  const barrel =
    `/* eslint-disable */\n/**\n * GENERATED — do not edit. Barrel for all AstraMem contract types.\n` +
    ` * Regenerate: node contracts/generate-types.mjs\n */\n` +
    barrelExports.join('\n') +
    '\n';
  writeFileSync(join(TYPES_DIR, 'index.d.ts'), barrel, 'utf-8');
  console.log(`  generated types/index.d.ts  (${schemaFiles.length} schemas)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
