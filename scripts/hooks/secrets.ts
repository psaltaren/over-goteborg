// The secrets guard, run by the pre-commit hook (scripts/hooks/pre-commit) on what is staged: no key, token or
// password file reaches a commit, from a person or an agent. The repository is public, and a key that was pushed once
// is spent even if a later commit removes it. Keys live in `.env.local` (ignored by git) and as Worker secrets.
// The patterns are here, apart from the hook, so tests/secrets.test.ts can pin them down.

/** Files that hold secrets by their nature. `.env.example` is the one allowed: it documents names, not values. */
const FILES = [/(^|\/)\.env(?!\.example$)(\..*)?$/, /(^|\/)\.dev\.vars$/, /\.(pem|p12|pfx|key)$/, /(^|\/)id_(rsa|ed25519|ecdsa)$/];

/**
 * Secrets by their look. A name alone (`TRAFIKLAB_RT_KEY` in a doc) passes; a name with a value does not. A value is
 * one run of 16 or more key characters with a digit in it, so code that reads a secret (`= env.NOTES_ADMIN_TOKEN`)
 * passes too.
 */
const CONTENT: Array<[string, RegExp]> = [
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['a key or token assigned a value', /\b[A-Z][A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD)\s*[=:]\s*['"]?(?=[A-Za-z_\-+/]*\d)[A-Za-z0-9_\-+/]{16,}/],
  ['an HTTP Basic credential', /\bBasic\s+[A-Za-z0-9+/]{24,}={0,2}/],
  ['a GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}/],
  ['an Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['an OpenAI key', /\bsk-(proj-)?[A-Za-z0-9_-]{32,}/],
  ['an AWS key', /\bAKIA[0-9A-Z]{16}\b/],
];

export interface Finding { path: string; why: string; line?: number }

/** What in these staged files looks like a secret. */
export function secretsIn(files: Array<{ path: string; text: string }>): Finding[] {
  const found: Finding[] = [];
  for (const { path, text } of files) {
    if (FILES.some((re) => re.test(path))) {
      found.push({ path, why: 'a file that holds secrets' });
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const [why, re] of CONTENT) if (re.test(lines[i])) found.push({ path, why, line: i + 1 });
    }
  }
  return found;
}

if (import.meta.main) {
  const git = (args: string[]) => Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'ignore' });
  const names = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).stdout.toString().split('\0').filter(Boolean);
  const files: Array<{ path: string; text: string }> = [];
  for (const path of names) {
    const blob = git(['show', `:${path}`]).stdout;
    // Binary files and big data files (map tiles, the timetable) are not where a key hides; their names still count.
    const text = blob.length > 2_000_000 || blob.includes(0) ? '' : blob.toString();
    files.push({ path, text });
  }
  const found = secretsIn(files);
  if (found.length) {
    console.error('pre-commit: this looks like a secret, so the commit stops:');
    for (const f of found) console.error(`  ${f.path}${f.line ? `:${f.line}` : ''}  ${f.why}`);
    console.error('Keys belong in .env.local (ignored by git) or as Worker secrets (`bunx wrangler secret put`). Unstage it with `git restore --staged <file>`. If it is not a secret, change the line so it does not look like one.');
    process.exit(1);
  }
}
