# Hello world

可运行的 isr-engine 示例，使用同一份页面目录生成标题和动态 SEO。

| 路径 | 渲染 |
|---|---|
| `/` | ISR，缓存 60 秒 |
| `/about` | SSG，构建时预渲染 |
| `/guides/rendering` | SSR，每次请求渲染 |

在示例目录使用 Node.js 24.15.0 安装并启动。

```bash
npm install
npm run dev
npm run build
npm start
```

默认地址为 `http://localhost:3000`。独立使用时，将 `isr-engine` 的
`file:../..` 换成 npmjs 版本。本仓库的 CI 会用待验证的 npm 压缩包安装本例，
并验证生产路由和 HTML 标题。
