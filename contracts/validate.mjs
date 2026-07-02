#!/usr/bin/env node
/**
 * contracts/validate.mjs — compiles every JSON Schema under contracts/schemas/
 * (draft 2020-12) and asserts:
 *   - every contracts/fixtures/valid/<prefix>-*.json fixture PASSES its schema
 *   - every contracts/fixtures/invalid/<prefix>-*.json fixture FAILS its schema
 *
 * <prefix> is derived from the schema filename: "atom.v1.schema.json" ->
 * "atom-v1-", so "atom-v1-decision-string-evidence.json" is routed to
 * atom.v1.schema.json. This is the same convention the cloud repo's CI must
 * follow when it points its own runner at this directory (see README.md
 * "Cloud consumption").
 *
 * No dependencies beyond ajv + ajv-formats (root devDependencies — this
 * script is plain Node, no TS build step required, so cloud's CI can run it
 * with only `npm ci && node contracts/validate.mjs`).
 *
 * Exit code: 0 if every fixture behaves as its directory name promises,
 * non-zero otherwise. Per-file PASS/FAIL is printed as it runs.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = join(__dirname, 'schemas');
const VALID_DIR = join(__dirname, 'fixtures', 'valid');
const INVALID_DIR = join(__dirname, 'fixtures', 'invalid');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/** "atom.v1.schema.json" -> "atom-v1-" fixture-name prefix. */
function prefixForSchema(schemaFileName) {
  const m = schemaFileName.match(/^(.+)\.v(\d+)\.schema\.json$/);
  if (!m) {
    throw new Error(`schema file does not match "<name>.v<N>.schema.json": ${schemaFileName}`);
  }
  return `${m[1]}-v${m[2]}-`;
}

function main() {
  // strict: true catches typos, unused keywords, etc. strictRequired is
  // relaxed to false: it otherwise demands every `required` property have a
  // sibling `properties` entry in the SAME subschema, which is incompatible
  // with the if/then conditional-require pattern used by
  // capture-envelope.v1.schema.json (kind:"events" -> require "events",
  // where "events"/"turns" are declared once at the schema root, not
  // duplicated inside each `then` branch).
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  addFormats(ajv);

  const schemaFiles = readdirSync(SCHEMAS_DIR).filter(f => f.endsWith('.schema.json')).sort();
  if (schemaFiles.length === 0) {
    console.error('FAIL: no schema files found under contracts/schemas/');
    process.exit(1);
  }

  const validFixtures = readdirSync(VALID_DIR).filter(f => f.endsWith('.json'));
  const invalidFixtures = readdirSync(INVALID_DIR).filter(f => f.endsWith('.json'));

  let failures = 0;
  let checks = 0;
  const matchedValid = new Set();
  const matchedInvalid = new Set();

  for (const schemaFile of schemaFiles) {
    const schema = readJson(join(SCHEMAS_DIR, schemaFile));
    let validateFn;
    try {
      validateFn = ajv.compile(schema);
      console.log(`COMPILE OK  ${schemaFile}`);
    } catch (err) {
      console.error(`COMPILE FAIL  ${schemaFile}: ${err.message}`);
      failures++;
      continue;
    }

    const prefix = prefixForSchema(schemaFile);

    for (const fixtureFile of validFixtures) {
      if (!fixtureFile.startsWith(prefix)) continue;
      matchedValid.add(fixtureFile);
      checks++;
      const data = readJson(join(VALID_DIR, fixtureFile));
      const ok = validateFn(data);
      if (ok) {
        console.log(`  PASS (expected valid)    valid/${fixtureFile}`);
      } else {
        console.error(`  FAIL (expected valid)    valid/${fixtureFile}`);
        console.error(`    ${ajv.errorsText(validateFn.errors, { separator: '\n    ' })}`);
        failures++;
      }
    }

    for (const fixtureFile of invalidFixtures) {
      if (!fixtureFile.startsWith(prefix)) continue;
      matchedInvalid.add(fixtureFile);
      checks++;
      const data = readJson(join(INVALID_DIR, fixtureFile));
      const ok = validateFn(data);
      if (!ok) {
        console.log(`  PASS (expected invalid)  invalid/${fixtureFile}`);
      } else {
        console.error(`  FAIL (expected invalid, but schema accepted it)  invalid/${fixtureFile}`);
        failures++;
      }
    }
  }

  // Every fixture file must have matched exactly one schema prefix — an
  // unmatched fixture silently skips validation, which would defeat the gate.
  for (const f of validFixtures) {
    if (!matchedValid.has(f)) {
      console.error(`FAIL: valid/${f} did not match any schema prefix — check its filename`);
      failures++;
    }
  }
  for (const f of invalidFixtures) {
    if (!matchedInvalid.has(f)) {
      console.error(`FAIL: invalid/${f} did not match any schema prefix — check its filename`);
      failures++;
    }
  }

  console.log(`\n${checks} fixture checks run, ${failures} failure(s).`);
  if (failures > 0) {
    process.exit(1);
  }
}

main();
