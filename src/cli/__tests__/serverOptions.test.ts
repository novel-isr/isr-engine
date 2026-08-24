import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { addServerBindingOptions } from '../serverOptions';

function parseOptions(args: string[]): { port?: string; host?: string } {
  const command = addServerBindingOptions(new Command());
  command.parse(['node', 'novel-isr', ...args]);
  return command.opts();
}

describe('addServerBindingOptions', () => {
  it('does not synthesize overrides when CLI flags are omitted', () => {
    expect(parseOptions([])).toEqual({});
  });

  it('passes explicit port and host overrides through unchanged', () => {
    expect(parseOptions(['--port', '8080', '--host', '0.0.0.0'])).toEqual({
      port: '8080',
      host: '0.0.0.0',
    });
  });
});
