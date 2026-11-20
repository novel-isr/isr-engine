const releaseArchive = '.release/isr-engine-${nextRelease.version}.tgz';

export default {
  branches: ['main'],
  tagFormat: 'isr-engine-v${version}',
  plugins: [
    [
      '@semantic-release/commit-analyzer',
      {
        releaseRules: [
          { breaking: true, release: 'major' },
          { type: 'feat', release: 'minor' },
          { type: 'ci', release: false },
          { type: '!(ci)', release: 'patch' },
        ],
      },
    ],
    '@semantic-release/release-notes-generator',
    ['@semantic-release/npm', { tarballDir: '.release' }],
    [
      '@semantic-release/exec',
      { prepareCmd: `pnpm run test:package ${releaseArchive} && pnpm run audit:security` },
    ],
  ],
  // Keep the npm plugin's OIDC check and packaging, then publish the checked archive.
  publish: [
    [
      '@semantic-release/exec',
      {
        publishCmd: `npm publish ${releaseArchive} --tag latest --json`,
      },
    ],
  ],
};
