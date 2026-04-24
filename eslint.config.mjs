import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

export default [
  // 基础 JavaScript 规则
  js.configs.recommended,

  // 忽略的文件和目录
  {
    ignores: [
      'dist/**',
      'build/**',
      'out/**',
      '.cache/**',
      '.parcel-cache/**',
      '.vite/**',
      '.turbo/**',
      'node_modules/**',
      '*.config.js',
      '*.config.mjs',
      '*.config.ts',
      'vite.config.*',
      'coverage/**',
      '.git/**',
      '.coverage/**',
      '.nyc_output/**',
      'coverage/**',
      'logs/**',
      'pids/**',
      'tmp/**',
      'temp/**',
      '*.log',
    ],
  },

  // src/defaults/** 单独走自己的 tsconfig
  // —— 这些文件依赖 @vitejs/plugin-rsc 的运行时注入 API（import.meta.viteRsc）
  // 不能用 engine 主 tsconfig 编译（会缺类型），由 src/defaults/tsconfig.json 单独管
  {
    files: ['src/defaults/**/*.ts', 'src/defaults/**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node, React: 'readonly' },
      parserOptions: {
        ecmaFeatures: { jsx: true },
        project: './src/defaults/tsconfig.json',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      react,
      'react-hooks': reactHooks,
      prettier,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'no-console': 'off',
      ...prettierConfig.rules,
      'prettier/prettier': ['error', {}, { usePrettierrc: true }],
    },
    settings: {
      react: { version: 'detect' },
    },
  },

  // TypeScript 文件配置 - Node.js 环境（engine 主代码）
  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['src/defaults/**'],
    languageOptions: {
      parser: tsparser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
        project: './tsconfig.json',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      react,
      'react-hooks': reactHooks,
      prettier,
    },
    rules: {
      // TypeScript 规则
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // 框架代码不允许 any escape hatch —— 类型不准就让它编译失败，别让它静悄悄通过
      // src/defaults/** 例外（仍 'off'，因为依赖 plugin-rsc 注入的运行时类型）
      // 配置文件例外（见底部 *.config.* override）
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-empty-function': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',

      // React 规则
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off', // React 17+
      'react/prop-types': 'off', // TypeScript 已处理
      'react/jsx-uses-react': 'off', // React 17+
      'react/jsx-uses-vars': 'error',

      // Node.js 环境规则
      'no-console': 'off', // ISR 引擎需要日志
      'no-debugger': 'warn',
      'no-unused-vars': 'off', // 使用 TypeScript 版本
      'no-undef': 'off', // TypeScript 处理未定义变量
      'no-redeclare': 'off', // TypeScript 处理函数重载
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': 'error',
      'prefer-arrow-callback': 'error',

      // 代码风格规则
      indent: 'off', // 让 Prettier 处理
      quotes: ['error', 'single', { avoidEscape: true }],
      semi: ['error', 'always'],
      'comma-dangle': ['error', 'always-multiline'],
      'max-len': ['warn', { code: 120, ignoreUrls: true }],

      // Prettier 集成
      ...prettierConfig.rules,
      'prettier/prettier': ['error', {}, { usePrettierrc: true }],
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
  },

  // JavaScript 文件配置 - Node.js 环境
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    plugins: {
      prettier,
    },
    rules: {
      // Node.js 环境规则
      'no-console': 'off',
      'no-debugger': 'warn',
      'no-unused-vars': 'warn',
      'no-undef': 'off', // Node.js 环境，由 @types/node 处理
      'prefer-const': 'error',
      'no-var': 'error',

      // 代码风格
      quotes: ['error', 'single', { avoidEscape: true }],
      semi: ['error', 'always'],
      'comma-dangle': ['error', 'always-multiline'],

      // Prettier 集成
      ...prettierConfig.rules,
      'prettier/prettier': ['error', {}, { usePrettierrc: true }],
    },
  },

  // 配置文件特殊规则
  {
    files: ['**/*.config.{js,mjs,ts}', 'vite.config.*'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
];
