import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createLoadDiagnostics } from '../diagnostics.mjs';

function socket(port) {
  return Object.assign(new EventEmitter(), {
    localPort: port,
    bytesRead: 0,
    bytesWritten: 0,
    writableLength: 0,
    connecting: false,
    destroyed: false,
  });
}

describe('benchmark connection diagnostics', () => {
  it('records the original timed-out socket after autocannon replaces client.conn', () => {
    const diagnostics = createLoadDiagnostics();
    const client = new EventEmitter();
    diagnostics.setupClient(client);
    const original = socket(41000);
    client.conn = original;
    client.emit('request');
    original.emit('connect');
    original.bytesWritten = 120;
    original.destroyed = true;
    client.conn = socket(42000);
    client.emit('request');
    client.emit('timeout');
    const result = diagnostics.finish();
    expect(result.connections).toBe(2);
    expect(result.connected).toBe(1);
    expect(result.timeout_samples).toEqual([
      expect.objectContaining({ localPort: 41000, bytesWritten: 120, destroyed: true }),
    ]);
  });

  it('bounds timeout evidence and retains response and connection error totals', () => {
    const diagnostics = createLoadDiagnostics();
    const client = new EventEmitter();
    diagnostics.setupClient(client);
    for (let index = 0; index < 30; index++) {
      client.conn = socket(41000 + index);
      client.emit('request');
      client.conn.emit('connect');
      client.emit('response');
      client.emit('connError', { code: 'ECONNRESET' });
      client.emit('timeout');
    }
    const result = diagnostics.finish();
    expect(result.timeout_samples).toHaveLength(20);
    expect(result.completed).toBe(30);
    expect(result.connection_errors).toEqual({ ECONNRESET: 30 });
  });
});
