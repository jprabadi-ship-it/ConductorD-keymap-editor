// Prints the GitHub release notes for one version, taken from the in-app
// changelog in src/components/Header/Header.tsx so the two never disagree.
//
// Usage: node scripts/release-notes.mjs <version>   (e.g. 0.38.63)
//
// Each changelog entry sits on one line as an object literal:
//   { v: '0.38.63.0', at: '2026-10-27 JST', changes: ['...', '...'] },
// Exits with status 1 when the version has no entry.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
if (!version) {
  console.error('使い方: node scripts/release-notes.mjs <バージョン>');
  process.exit(2);
}

const header = fileURLToPath(new URL('../src/components/Header/Header.tsx', import.meta.url));
const marker = `v: '${version}.0'`;
const line = readFileSync(header, 'utf8').split('\n').find((l) => l.includes(marker));
if (!line) {
  console.error(`エラー: Header.tsx に ${version} の変更履歴がありません。`);
  process.exit(1);
}

const entry = new Function(`return (${line.trim().replace(/,$/, '')});`)();
const notes = [
  ...entry.changes.map((c) => `- ${c}`),
  '',
  `${entry.at} 公開。Apple の公証済みです。`,
].join('\n');
console.log(notes);
