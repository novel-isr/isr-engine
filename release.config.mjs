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
      { prepareCmd: 'pnpm run test:package .release/isr-engine-${nextRelease.version}.tgz' },
    ],
  ],
};
