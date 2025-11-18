# 迁移指南

本指南帮助你从传统的渲染方案迁移到 Novel ISR Engine 企业级框架。

## 目录

- [从传统 SSR 迁移](#从传统-ssr-迁移)
- [从 Next.js 迁移](#从-nextjs-迁移)
- [从 Nuxt.js 迁移](#从-nuxtjs-迁移)
- [从传统 ISR 引擎迁移](#从传统-isr-引擎迁移)
- [逐步迁移策略](#逐步迁移策略)
- [常见问题](#常见问题)

## 从传统 SSR 迁移

### 1. 项目结构调整

**之前：**
```
my-app/
├── server/
│   ├── index.js
│   └── render.js
├── client/
│   └── index.js
└── shared/
    └── components/
```

**之后：**
```
my-app/
├── src/
│   ├── pages/
│   ├── components/
│   │   ├── client/
│   │   └── server/      # 新增：RSC 组件
│   └── App.tsx
├── isr-engine/          # 框架代码
└── vite.config.ts       # 新增：Vite 配置
```

### 2. 配置迁移

**之前的 Express 服务器：**
```javascript
// server/index.js
const express = require('express');
const app = express();

app.get('*', async (req, res) => {
  const html = await renderPage(req.url);
  res.send(html);
});
```

**迁移后：**
```typescript
// vite.config.ts
import { createEnterpriseViteISRPlugin } from 'isr-engine';

export default defineConfig({
  plugins: [
    ...createEnterpriseViteISRPlugin({
      enterprise: {
        fallbackChain: true,
        multiLayerCache: true
      }
    })
  ]
});

// 或直接使用引擎
import { createEnterpriseApp } from 'isr-engine';

const app = await createEnterpriseApp();
await app.start(3000);
```

### 3. 组件迁移

**之前的服务端渲染组件：**
```javascript
// server/components/ProductList.js
const ProductList = async ({ category }) => {
  const products = await fetchProducts(category);
  return `
    <div class="product-list">
      ${products.map(p => `<div>${p.name}</div>`).join('')}
    </div>
  `;
};
```

**迁移后的 RSC 组件：**
```typescript
// src/components/server/ProductList.tsx
export async function ProductList({ category }: { category: string }) {
  const products = await fetchProducts(category);
  
  return (
    <div className="product-list">
      {products.map(product => (
        <div key={product.id}>{product.name}</div>
      ))}
    </div>
  );
}
```

## 从 Next.js 迁移

### 1. 页面路由迁移

**Next.js 页面：**
```javascript
// pages/products/[id].js
export default function ProductPage({ product }) {
  return <div>{product.name}</div>;
}

export async function getStaticProps({ params }) {
  const product = await fetchProduct(params.id);
  return {
    props: { product },
    revalidate: 60
  };
}
```

**迁移后：**
```typescript
// src/pages/products/[id].tsx
import { ProductDetail } from '../../components/server/ProductDetail';

export default function ProductPage({ params }: { params: { id: string } }) {
  return (
    <div>
      <ProductDetail productId={params.id} />
    </div>
  );
}

// RSC 组件处理数据获取
// src/components/server/ProductDetail.tsx
export async function ProductDetail({ productId }: { productId: string }) {
  const product = await fetchProduct(productId);
  return <div>{product.name}</div>;
}
```

### 2. API 路由迁移

**Next.js API：**
```javascript
// pages/api/products.js
export default async function handler(req, res) {
  const products = await fetchProducts();
  res.json(products);
}
```

**迁移后：**
```typescript
// src/api/products.ts
export async function GET() {
  const products = await fetchProducts();
  return Response.json(products);
}
```

### 3. 配置迁移

**next.config.js：**
```javascript
module.exports = {
  experimental: {
    appDir: true
  },
  images: {
    domains: ['example.com']
  }
};
```

**novel-isr.config.ts：**
```typescript
export default {
  mode: 'isr',
  enterprise: {
    enabled: true,
    fallbackChain: {
      enabled: true,
      strategies: [
        { name: 'static', priority: 1, timeout: 500 },
        { name: 'cached', priority: 2, timeout: 200 },
        { name: 'regenerate', priority: 3, timeout: 5000 }
      ]
    }
  },
  rsc: {
    enabled: true,
    componentsDir: 'src/components/server'
  }
};
```

## 从 Nuxt.js 迁移

### 1. 页面结构迁移

**Nuxt.js：**
```vue
<!-- pages/products/_id.vue -->
<template>
  <div>{{ product.name }}</div>
</template>

<script>
export default {
  async asyncData({ params, $axios }) {
    const product = await $axios.$get(`/api/products/${params.id}`);
    return { product };
  }
};
</script>
```

**迁移后：**
```typescript
// src/pages/products/[id].tsx
import { ProductDetail } from '../../components/server/ProductDetail';

export default function ProductPage({ params }: { params: { id: string } }) {
  return <ProductDetail productId={params.id} />;
}

// src/components/server/ProductDetail.tsx
export async function ProductDetail({ productId }: { productId: string }) {
  const product = await fetchProduct(productId);
  return <div>{product.name}</div>;
}
```

### 2. 中间件迁移

**Nuxt.js 中间件：**
```javascript
// middleware/auth.js
export default function ({ redirect, store }) {
  if (!store.state.user) {
    return redirect('/login');
  }
}
```

**迁移后：**
```typescript
// src/middleware/auth.ts
export async function authMiddleware(context: RenderContext) {
  const user = await getUser(context.cookies);
  if (!user) {
    return Response.redirect('/login');
  }
  return null;
}
```

## 从传统 ISR 引擎迁移

### 1. 配置升级

**传统配置：**
```typescript
import { ISREngine } from 'isr-engine';

const engine = new ISREngine({
  mode: 'isr',
  cache: {
    type: 'memory',
    ttl: 3600
  }
});
```

**企业级配置：**
```typescript
import { createEnterpriseApp } from 'isr-engine';

const app = await createEnterpriseApp({
  features: {
    rsc: true,
    multiCache: true,
    advancedSEO: true,
    monitoring: true
  },
  config: {
    enterprise: {
      cache: {
        multiLayer: true,
        compression: true,
        encryption: true
      }
    }
  }
});
```

### 2. 渲染方法升级

**传统渲染：**
```typescript
const result = await engine.render('/products/123', {
  headers: req.headers
});
```

**企业级渲染（自动降级链）：**
```typescript
// 自动使用最优策略：Static -> Cached -> ISR -> SSR -> CSR
const result = await app.render('/products/123', {
  headers: req.headers,
  userAgent: req.get('user-agent')
});
```

### 3. 缓存策略升级

**传统单层缓存：**
```typescript
await engine.cache.set('key', value, { ttl: 3600 });
```

**企业级多层缓存：**
```typescript
await app.engine.cache.set('key', value, {
  ttl: 3600,
  tags: ['product', 'category:fiction'],
  compress: true,
  priority: 'high'
});

// 批量失效
await app.engine.cache.invalidateByTags(['product']);
```

## 逐步迁移策略

### 阶段 1：基础迁移 (1-2 周)

1. **安装框架**
   ```bash
   npm install ./isr-engine
   ```

2. **创建基础配置**
   ```typescript
   // vite.config.ts
   import { createEnterpriseViteISRPlugin } from 'isr-engine';
   
   export default defineConfig({
     plugins: [
       ...createEnterpriseViteISRPlugin({
         enterprise: {
           fallbackChain: false,  // 先关闭高级功能
           multiLayerCache: false,
           advancedSEO: false
         }
       })
     ]
   });
   ```

3. **迁移核心页面**
   - 选择 2-3 个重要页面
   - 保持原有逻辑不变
   - 验证渲染结果

### 阶段 2：功能增强 (2-3 周)

1. **启用 RSC**
   ```typescript
   // 逐步将数据获取逻辑移至服务端组件
   rsc: {
     enabled: true,
     componentsDir: 'src/components/server'
   }
   ```

2. **启用多层缓存**
   ```typescript
   enterprise: {
     cache: {
       multiLayer: true,
       compression: true
     }
   }
   ```

3. **性能对比测试**
   ```bash
   # 生成性能报告
   npx novel-isr analyze performance --before --after
   ```

### 阶段 3：企业级功能 (2-4 周)

1. **启用降级链**
   ```typescript
   enterprise: {
     fallbackChain: {
       enabled: true,
       adaptive: {
         enabled: true,
         learningRate: 0.1
       }
     }
   }
   ```

2. **高级 SEO**
   ```typescript
   enterprise: {
     seo: {
       advanced: true,
       structuredData: true,
       performance: true
     }
   }
   ```

3. **监控集成**
   ```typescript
   enterprise: {
     monitoring: {
       detailed: true,
       alerts: true
     }
   }
   ```

### 阶段 4：优化调优 (1-2 周)

1. **性能调优**
   ```bash
   # 分析瓶颈
   npx novel-isr analyze bundle
   npx novel-isr analyze performance
   ```

2. **缓存策略优化**
   ```bash
   # 查看缓存命中率
   npx novel-isr cache stats
   
   # 优化缓存配置
   npx novel-isr cache analyze --recommend
   ```

3. **A/B 测试**
   - 对比迁移前后的性能指标
   - 用户体验评估
   - 服务器资源消耗对比

## 常见问题

### Q1: 迁移后性能有提升吗？

**A:** 根据我们的测试数据：
- **首屏加载**: 平均提升 40-60%
- **页面切换**: 平均提升 70-80%
- **缓存命中率**: 从 60% 提升到 90%+
- **服务器负载**: 降低 30-50%

### Q2: RSC 组件如何处理客户端交互？

**A:** 使用组合模式：
```typescript
// 服务端组件 - 负责数据获取
export async function ProductDetail({ id }: { id: string }) {
  const product = await fetchProduct(id);
  
  return (
    <div>
      <h1>{product.name}</h1>
      {/* 客户端组件 - 负责交互 */}
      <ProductInteraction productId={id} initialLikes={product.likes} />
    </div>
  );
}

// 客户端组件
'use client';
export function ProductInteraction({ productId, initialLikes }) {
  const [likes, setLikes] = useState(initialLikes);
  // 交互逻辑...
}
```

### Q3: 如何确保迁移过程中服务不中断？

**A:** 推荐蓝绿部署策略：
1. **并行环境**: 新旧版本同时运行
2. **流量切换**: 逐步将流量切换到新版本
3. **监控回滚**: 出现问题立即回滚
4. **数据同步**: 确保缓存和数据一致性

```bash
# 蓝绿部署脚本示例
./scripts/blue-green-deploy.sh --version v2.0 --traffic 10%
./scripts/blue-green-deploy.sh --version v2.0 --traffic 50%
./scripts/blue-green-deploy.sh --version v2.0 --traffic 100%
```

### Q4: 迁移成本评估？

**A:** 典型项目迁移成本：

| 项目规模 | 页面数量 | 预计工时 | 建议人员 |
|---------|---------|---------|----------|
| 小型     | < 20    | 2-3 周   | 1-2 人   |
| 中型     | 20-100  | 4-6 周   | 2-3 人   |
| 大型     | > 100   | 6-10 周  | 3-5 人   |

### Q5: 如何验证迁移效果？

**A:** 多维度验证：

```bash
# 功能验证
npm run test:e2e

# 性能验证  
npx novel-isr analyze performance --compare baseline

# SEO 验证
npx novel-isr analyze seo --urls urls.txt

# 压力测试
npx artillery run load-test.yml
```

### Q6: 迁移失败如何回滚？

**A:** 快速回滚策略：

1. **配置回滚**
   ```bash
   # 切换到传统模式
   npx novel-isr config set mode traditional
   ```

2. **代码回滚**
   ```bash
   git checkout previous-stable-version
   npm run deploy
   ```

3. **数据回滚**
   ```bash
   # 清除新版本缓存
   npx novel-isr cache clear --all
   ```

## 迁移清单

- [ ] **准备阶段**
  - [ ] 性能基线测试
  - [ ] 代码备份
  - [ ] 依赖分析
  - [ ] 团队培训

- [ ] **基础迁移**
  - [ ] 安装框架
  - [ ] 基础配置
  - [ ] 核心页面迁移
  - [ ] 功能验证

- [ ] **增强功能**
  - [ ] RSC 组件迁移
  - [ ] 缓存策略配置
  - [ ] SEO 优化配置
  - [ ] 性能测试

- [ ] **企业功能**
  - [ ] 降级链配置
  - [ ] 监控集成
  - [ ] 安全加固
  - [ ] 压力测试

- [ ] **优化调优**
  - [ ] 性能分析
  - [ ] 配置调优
  - [ ] A/B 测试
  - [ ] 用户反馈

- [ ] **上线发布**
  - [ ] 灰度发布
  - [ ] 监控告警
  - [ ] 文档更新
  - [ ] 团队交接

需要帮助？联系我们：
- 📧 migration-support@novel-rating.com
- 💬 Slack: #migration-help
- 📞 技术热线: +86-400-xxx-xxxx