# Novel SSR Engine 快速入门

## 10 秒快速开始

### 1. 安装即用

```bash
# 一键安装
npm install @novel-isr/engine

# 直接启动（零配置）
npx novel-isr dev
```

🎉 **完成！** 访问 http://localhost:3000

### 2. 自定义配置（可选）

生成配置文件模板：

```bash
npx novel-isr init  # 自动生成 ssr.config.js 或 ssr.config.ts
```

或手动创建 `ssr.config.js`：

```javascript
export default {
  mode: 'isr',
  routes: {
    '/': 'ssg', // 首页静态生成
    '/*': 'isr', // 其他页面 ISR
  },
  seo: {
    baseUrl: 'https://your-domain.com',
  },
};
```

## 常用配置

### 基础配置

```javascript
// ssr.config.js
export default {
  mode: 'isr', // 默认模式
  server: { port: 3000 }, // 服务器端口
  routes: {
    '/': 'ssg', // 首页静态生成
    '/posts/*': 'isr', // 动态页面 ISR
  },
};
```

### TypeScript 配置

```typescript
// ssr.config.ts
import type { NovelSSRConfig } from '@novel-ssr/engine';

export default {
  mode: 'isr',
  routes: {
    '/': 'ssg',
    '/posts/*': 'isr',
  },
} satisfies NovelSSRConfig;
```

## React 应用集成

### 自动 Vite 配置

SSR Engine 已内置 Vite 和 React 支持，无需额外安装！

### 创建入口文件（可选）

```typescript
// src/entry-server.tsx
import React from 'react';
import { renderToString } from 'react-dom/server';
import App from './App';

export function render(url: string) {
  const html = renderToString(<App />);

  return {
    html: `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>My App</title>
  </head>
  <body>
    <div id="root">${html}</div>
    <script type="module" src="/src/entry-client.tsx"></script>
  </body>
</html>`,
    statusCode: 200
  };
}
```

## 常用命令

```bash
npx novel-isr dev      # 开发模式（零配置启动）
npx novel-isr init     # 生成配置文件模板
npx novel-isr build    # 构建生产版本
npx novel-isr start    # 启动生产服务器
npx novel-isr deploy   # 构建并生成部署资源
npx novel-isr stats    # 查看统计信息
```

## 部署

### Docker 部署

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npx novel-isr build
EXPOSE 3000
CMD ["npx", "novel-ssr", "start"]
```

### Vercel 部署

```json
{
  "version": 2,
  "builds": [
    {
      "src": "package.json",
      "use": "@vercel/node"
    }
  ]
}
```

## 故障排除

### 端口被占用

```bash
# 修改端口
echo 'export default { server: { port: 3001 } };' > ssr.config.js
```

### 构建失败

```bash
# 清理缓存并重新构建
rm -rf dist node_modules
npm install
npx novel-isr build
```

### 类型错误

```bash
# 确保安装类型包
npm install -D @types/node typescript
```

## 下一步

- 📖 查看完整文档: [README.md](./README.md)
- 🏗️ 了解架构设计: [SSR-ARCHITECTURE.md](./SSR-ARCHITECTURE.md)
- ⚙️ 高级配置选项
- 🚀 生产部署指南
