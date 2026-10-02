import { expect, test } from 'bun:test';
import { secretsIn } from '../scripts/hooks/secrets';

const one = (path: string, text = '') => secretsIn([{ path, text }]);
// The fake secrets are put together from parts, so this file does not trip the guard it tests.
const j = (...parts: string[]) => parts.join('');

test('files that hold secrets are stopped by their name', () => {
  for (const path of ['.env', '.env.local', 'server/.env.production', '.dev.vars', 'certs/site.pem', 'deploy.key', 'id_ed25519']) {
    expect(one(path).length).toBe(1);
  }
  for (const path of ['.env.example', 'src/game/env.ts', 'docs/keys.md', 'keyboard.ts']) {
    expect(one(path)).toEqual([]);
  }
});

test('keys with values are stopped, names alone pass', () => {
  for (const text of [
    j('TRAFIKLAB_RT_KEY', '=0123456789abcdef0123'),
    j('const VASTTRAFIK_SECRET', ' = "Zm9vYmFyYmF6cXV4MTIzNDU2"'),
    j("headers: { authorization: 'Basic", " ZXhhbXBsZWtleTpleGFtcGxlc2VjcmV0MTIz' }"),
    j('-----BEGIN OPENSSH ', 'PRIVATE KEY-----'),
    j('token = ghp', '_0123456789abcdefghijklmnopqrstuvwxyzAB'),
    j('note: sk-', 'ant-api03-abcdefghijklmnopqrstuvwxyz'),
    j('aws AKIA', 'ABCDEFGHIJKLMNOP'),
  ]) {
    expect(one('src/x.ts', text).length).toBeGreaterThan(0);
  }
  for (const text of [
    'Put `TRAFIKLAB_RT_KEY` and `TRAFIKLAB_STATIC_KEY` in .env.local.',
    'set once with `bunx wrangler secret put NOTES_ADMIN_TOKEN`',
    'const key = `${name}-${hash}`;',
    'const NOTES_ADMIN_TOKEN = env.NOTES_ADMIN_TOKEN;',
    'const SITE_URL = (process.env.SITE_URL ?? \'\');',
  ]) {
    expect(one('docs/DRIFT.md', text)).toEqual([]);
  }
});

test('a finding names the file and the line', () => {
  expect(one('src/a.ts', j('ok\nCLIENT_SECRET', '=abcdefghij0123456789\n'))).toEqual([{ path: 'src/a.ts', why: 'a key or token assigned a value', line: 2 }]);
});
