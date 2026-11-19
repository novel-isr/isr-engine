import { readFileSync } from 'node:fs';

export function kernelSnapshot() {
  const read = path => {
    try {
      return readFileSync(path, 'utf8').trim();
    } catch {
      return null;
    }
  };
  return {
    somaxconn: read('/proc/sys/net/core/somaxconn'),
    tcp_max_syn_backlog: read('/proc/sys/net/ipv4/tcp_max_syn_backlog'),
    netstat: read('/proc/net/netstat'),
    sockstat: read('/proc/net/sockstat'),
    limits: read('/proc/self/limits'),
  };
}
