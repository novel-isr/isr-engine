#!/usr/bin/env node
/**
 * prepublishOnly 守门员 —— 在 pnpm publish 真正打 tarball / 上传之前跑.
 *
 * 验两件事:
 *   1) npm/pnpm 解析出来的 effective registry 不是空的
 *   2) effective registry 不是 public registry.npmjs.org
 *
 * "effective registry" = pnpm publish 实际会用的那个 URL, 解析顺序:
 *   CLI flag --registry=...  >  publishConfig.registry  >  项目 .npmrc  >  ~/.npmrc  >  全局
 *
 * 本包 publishConfig 不写 registry, 所以来源一定在 .npmrc 或 CLI flag.
 * .npmrc 是 gitignored, 不会泄漏内部 URL 到 public github 仓.
 *
 * 失败时 exit 1 阻断发布, 提示如何配置.
 */

import { execSync } from 'node:child_process';

function getEffectiveRegistry() {
  try {
    const out = execSync('npm config get registry', { encoding: 'utf8' }).trim();
    return out === 'undefined' ? '' : out;
  } catch {
    return '';
  }
}

const registry = getEffectiveRegistry();

if (!registry) {
  console.error('✗ prepublishOnly: npm/pnpm could not resolve a registry.');
  console.error('  Configure one of:');
  console.error('    1. .npmrc:  @novel-isr:registry=https://your-internal.example/');
  console.error('    2. CLI:     pnpm publish --registry=https://your-internal.example/');
  process.exit(1);
}

if (/registry\.npmjs\.org/.test(registry)) {
  console.error(`✗ prepublishOnly: refusing to publish internal package to public npmjs.`);
  console.error(`  Resolved registry: ${registry}`);
  console.error(`  This package is internal-only. Use a private registry.`);
  process.exit(1);
}

console.log(`✓ prepublishOnly: publishing to ${registry}`);
