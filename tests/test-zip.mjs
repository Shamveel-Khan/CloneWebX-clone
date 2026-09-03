// Tests for lib/zip.js — build a real archive and verify it with the system
// `unzip` binary (structural integrity + entry names + content match).
// Run: node tests/test-zip.mjs

import { buildZip, utf8Bytes } from '../extension/lib/zip.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
function assert(cond, label) {
  if (cond) {
    console.log('  ok — ' + label);
  } else {
    failures++;
    console.error('  FAIL — ' + label);
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'sr-zip-'));
const zipPath = join(tmp, 'test.zip');

// Small text file + a pseudo-binary blob > 64KB (covers multi-chunk data).
const bigText = ('Site Rebuilder line of text. ').repeat(4000);
const binary = new Uint8Array(70_000);
for (let i = 0; i < binary.length; i++) binary[i] = (i * 31) % 256;

const blob = buildZip([
  { name: 'package.json', data: utf8Bytes(JSON.stringify({ format: 'site-rebuilder/1', pages: [] })) },
  { name: 'assets/readme.txt', data: utf8Bytes(bigText) },
  { name: 'assets/blob.bin', data: binary },
  { name: 'dir/nested/únicode name.txt', data: utf8Bytes('utf8 filename check') },
]);

const buf = Buffer.from(await blob.arrayBuffer());
writeFileSync(zipPath, buf);

console.log('test-zip:');
assert(buf.subarray(0, 2).toString('latin1') === 'PK', 'archive starts with PK signature');
assert(buf.length > 70_000, `archive holds the binary payload (${buf.length} bytes)`);

const t = spawnSync('unzip', ['-t', zipPath], { encoding: 'utf8' });
assert(t.status === 0, `unzip -t reports no errors (${(t.stderr || t.stdout).split('\n').slice(-2).join(' ').trim()})`);

const list = spawnSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' });
const names = list.stdout.split('\n').filter(Boolean);
assert(names.length === 4, `exactly 4 entries (${names.length})`);
assert(names.includes('package.json'), 'package.json present');
assert(names.includes('assets/readme.txt'), 'nested entry present');
// The system `unzip` lists UTF-8 names through a CP437 lens, so verify the
// stored name bytes directly: the central directory must contain the raw
// UTF-8 encoding of the unicode name (the 0x0800 flag marks it as UTF-8).
assert(buf.includes(Buffer.from('únicode name.txt', 'utf8')), 'unicode filename stored as raw UTF-8 bytes');

const outDir = join(tmp, 'out');
spawnSync('unzip', ['-q', zipPath, '-d', outDir]);
const readme = readFileSync(join(outDir, 'assets/readme.txt'), 'utf8');
assert(readme === bigText, 'text entry round-trips byte-exact');
const blob2 = readFileSync(join(outDir, 'assets/blob.bin'));
assert(Buffer.compare(blob2, Buffer.from(binary)) === 0, 'binary entry round-trips byte-exact');

rmSync(tmp, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}
console.log('\nall zip tests passed');
