import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const temporary: string[] = [];
const script = path.resolve('scripts/check-code-scanning.mjs');
function directory(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'isr-code-scanning-'));
  temporary.push(dir);
  return dir;
}
function report(dir: string, results: unknown[], name = 'source.sarif'): void {
  writeFileSync(
    path.join(dir, name),
    JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'CodeQL' } }, results }] })
  );
}
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('release code-scanning policy', () => {
  it.each([
    { executionSuccessful: false },
    { executionSuccessful: true, exitCode: 1 },
    {
      executionSuccessful: true,
      toolExecutionNotifications: [{ level: 'error', message: { text: 'partial analysis' } }],
    },
    {
      executionSuccessful: true,
      toolConfigurationNotifications: [{ level: 'error', message: { text: 'missing query pack' } }],
    },
  ])('rejects explicitly failed analysis even without findings: %j', invocation => {
    const dir = directory();
    writeFileSync(
      path.join(dir, 'source.sarif'),
      JSON.stringify({
        version: '2.1.0',
        runs: [{ tool: { driver: { name: 'CodeQL' } }, results: [], invocations: [invocation] }],
      })
    );
    expect(spawnSync(process.execPath, [script, dir]).status).toBe(1);
  });

  it('accepts complete CodeQL output with no findings', () => {
    const dir = directory();
    report(dir, []);
    expect(execFileSync(process.execPath, [script, dir], { encoding: 'utf8' })).toContain(
      '0 findings'
    );
  });

  it.each(['error', 'warning', 'note'])(
    'blocks every %s finding including suppressed results',
    level => {
      const dir = directory();
      report(dir, [
        {
          ruleId: 'js/security',
          level,
          message: { text: 'untrusted\n::error::data' },
          suppressions: [{ kind: 'external', status: 'accepted' }],
        },
      ]);
      const result = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('"ruleId":"js/security"');
      expect(result.stdout).not.toContain('\n::error::');
    }
  );

  it('checks every SARIF file rather than trusting the first clean result', () => {
    const dir = directory();
    report(dir, []);
    mkdirSync(path.join(dir, 'nested'));
    report(path.join(dir, 'nested'), [{ ruleId: 'js/security', message: { text: 'finding' } }]);
    expect(spawnSync(process.execPath, [script, dir]).status).toBe(1);
  });

  it.each(['missing', 'empty', 'invalid-json', 'missing-runs', 'wrong-tool', 'missing-results'])(
    'rejects incomplete evidence: %s',
    kind => {
      const dir = directory();
      if (kind === 'invalid-json') writeFileSync(path.join(dir, 'source.sarif'), '{');
      if (kind === 'missing-runs')
        writeFileSync(
          path.join(dir, 'source.sarif'),
          JSON.stringify({ version: '2.1.0', runs: [] })
        );
      if (kind === 'wrong-tool')
        writeFileSync(
          path.join(dir, 'source.sarif'),
          JSON.stringify({
            version: '2.1.0',
            runs: [{ tool: { driver: { name: 'Other' } }, results: [] }],
          })
        );
      if (kind === 'missing-results')
        writeFileSync(
          path.join(dir, 'source.sarif'),
          JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'CodeQL' } } }] })
        );
      expect(
        spawnSync(process.execPath, [script, kind === 'missing' ? path.join(dir, 'missing') : dir])
          .status
      ).toBe(1);
    }
  );
});
