// FEAT-445 single-binary spike, STEP 1 probe.
// Does better-sqlite3-multiple-ciphers load AT ALL under plain `bun run` (no --compile)?
// Run with: bun run scripts/spike/bun-cipher-probe.cjs
// Compare with: node scripts/spike/bun-cipher-probe.cjs
console.log('probe start, runtime=', typeof Bun !== 'undefined' ? ('bun ' + Bun.version) : ('node ' + process.version));
const D = require('better-sqlite3-multiple-ciphers');
console.log('required ok, ctor typeof=', typeof D);
const dbPath = require('path').join(require('os').tmpdir(), 'feat445-probe.sqlite');
console.log('about to open file-backed encrypted db at', dbPath);
const db = new D(dbPath);
console.log('opened file db ok');
db.pragma("key='testkey123'");
console.log('pragma key set (cipher engaged)');
db.exec('CREATE TABLE t(x)');
console.log('table created');
db.prepare('INSERT INTO t VALUES (1)').run();
console.log('insert ok');
const row = db.prepare('SELECT * FROM t').get();
console.log('row=', row);
db.close();
console.log('ALL GOOD');
