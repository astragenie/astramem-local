#!/usr/bin/env node
/**
 * contracts/generate-zod.mjs — generates runtime Zod validators from every JSON
 * Schema under contracts/schemas/ (draft 2020-12) into contracts/zod/.
 *
 * Why: TypeScript consumers that validate untrusted wire input at runtime
 * (astramem-plugin's providers call `.parse()` on backend responses; astramem-
 * local's routes validate request bodies) want a Zod schema, not just a
 * compile-time `.d.ts` (generate-types.mjs) or an ajv+JSON-Schema pass. This
 * emits canonical Zod so consumers stop hand-rolling their own — the drift this
 * package exists to prevent. JSON Schema stays the single source of truth; the
 * Zod files are a GENERATED build artifact, never hand-edited.
 *
 * Output: one <name>.v<N>.ts per schema exporting a `<Name>V<N>Schema` Zod const
 * + an index.ts barrel. Consumers: `import { RetrievalQueryV1Schema } from
 * '@astragenie/astramem-contracts/zod'`.
 *
 * Dep: json-schema-to-zod (root devDependency). Plain Node ESM, mirrors
 * generate-types.mjs so one `node contracts/*.mjs` CI invocation covers both.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { jsonSchemaToZod } from 'json-schema-to-zod';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = join(__dirname, 'schemas');
const ZOD_DIR = join(__dirname, 'zod');

/** "atom.v1.schema.json" -> "AtomV1" -> const "AtomV1Schema". */
function baseNameForSchema(schemaFileName) {
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
  mkdirSync(ZOD_DIR, { recursive: true });

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
    const base = baseNameForSchema(file);
    const constName = `${base}Schema`;
    const outBase = outBaseForSchema(file);

    const zodModule = jsonSchemaToZod(schema, { name: constName, module: 'esm', type: base });

    const banner =
      `/* eslint-disable */\n/**\n * GENERATED — do not edit. Source: contracts/schemas/${file}\n` +
      ` * Regenerate: node contracts/generate-zod.mjs\n */\n`;
    writeFileSync(join(ZOD_DIR, `${outBase}.ts`), banner + zodModule, 'utf-8');
    barrelExports.push(`export { ${constName}, type ${base} } from './${outBase}.js';`);
    console.log(`  generated zod/${outBase}.ts  (${constName})`);
  }

  const barrel =
    `/* eslint-disable */\n/**\n * GENERATED — do not edit. Barrel for all AstraMem contract Zod validators.\n` +
    ` * Regenerate: node contracts/generate-zod.mjs\n */\n` +
    barrelExports.join('\n') +
    '\n';
  writeFileSync(join(ZOD_DIR, 'index.ts'), barrel, 'utf-8');
  console.log(`  generated zod/index.ts  (${schemaFiles.length} schemas)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
