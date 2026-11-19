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
    [
      '@semantic-release/exec',
      { prepareCmd: 'node scripts/prepare-release.mjs ${nextRelease.version}' },
    ],
    ['@semantic-release/npm', { tarballDir: '.release' }],
  ],
};
