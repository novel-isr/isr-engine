export default {
  branches: ['main'],
  tagFormat: 'v${version}',
  plugins: [
    [
      '@semantic-release/commit-analyzer',
      {
        releaseRules: [
          { breaking: true, release: 'major' },
          { type: 'feat', release: 'minor' },
          { release: 'patch' },
        ],
      },
    ],
    '@semantic-release/release-notes-generator',
    [
      '@semantic-release/exec',
      { prepareCmd: 'node scripts/prepare-release.mjs ${nextRelease.version}' },
    ],
    ['@semantic-release/npm', { tarballDir: '.release' }],
    [
      '@semantic-release/github',
      {
        assets: '.release/*.tgz',
        successComment: false,
        failComment: false,
        failTitle: false,
        releasedLabels: false,
      },
    ],
  ],
};
