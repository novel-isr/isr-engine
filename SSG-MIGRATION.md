# SSG 模块重构和迁移指南

## 问题概述

原始的 SSG 实现存在以下问题：

1. **双实现重复**: engine + scripts 目录存在重复的 SSG 逻辑
2. **开发污染 dist**: 开发模式下写入 `dist/` 目录，污染构建产物
3. **维护困难**: 多套实现导致逻辑不一致，难以维护

## 解决方案

### ✅ 新的架构设计

```
┌─────────────────────────────────┐
│         CLI/Scripts             │ ← 命令行接口
├─────────────────────────────────┤  
│         SSGManager              │ ← 企业级管理器
├─────────────────────────────────┤
│      SSGModule (兼容层)          │ ← 向后兼容
├─────────────────────────────────┤
│    UnifiedSSGGenerator          │ ← 核心统一生成器
└─────────────────────────────────┘
```

### 🎯 核心改进

#### 1. 统一生成器 (`UnifiedSSGGenerator`)
- **单一真相来源**: 所有 SSG 逻辑集中在一个地方
- **环境隔离**: 开发和生产使用不同的输出目录
- **智能缓存**: 支持 TTL、并发控制、内存管理
- **并发优化**: 可配置的并发生成数量

#### 2. 开发污染解决
```typescript
// ❌ 旧方式 - 污染 dist
outputDir: 'dist/client'  // 开发时也写入 dist

// ✅ 新方式 - 环境隔离  
outputDir: {
  production: 'dist/client',   // 生产环境
  development: '.ssg-cache'    // 开发环境独立目录
}
```

#### 3. 双实现统一
- **统一 API**: 所有组件使用相同的生成器
- **配置统一**: 单一配置文件控制所有行为
- **逻辑复用**: 避免重复实现

## 迁移指南

### 从旧 SSGModule 迁移

#### 旧代码:
```typescript
const ssg = new SSGModule(config);
await ssg.generateStaticPages();
```

#### 新代码:
```typescript
// 选项 1: 继续使用 SSGModule (已重构，无需改动)
const ssg = new SSGModule(config);
ssg.setRenderFunction(renderFunction); // 需要添加这行
await ssg.generateStaticPages();

// 选项 2: 升级到 SSGManager (推荐)
const ssgManager = new SSGManager(config);
await ssgManager.initialize(renderFunction);
const results = await ssgManager.prebuild();
```

### 配置文件迁移

#### 旧配置:
```typescript
// ssr.config.ts
export default {
  ssg: {
    routes: ['/', '/about'],
    outputDir: 'dist/client'  // 单一输出目录
  }
}
```

#### 新配置:
```typescript  
// ssr.config.ts
export default {
  ssg: {
    routes: ['/', '/about'],
    outputDir: {
      production: 'dist/client',
      development: '.ssg-cache'  // 环境隔离
    },
    onDemandGeneration: true,
    caching: {
      enabled: true,
      ttl: 3600
    }
  }
}
```

### .gitignore 更新

添加以下内容到 `.gitignore`:
```gitignore
# SSG 开发缓存
.ssg-cache/
```

## 功能对比

| 功能 | 旧实现 | 新实现 | 改进 |
|------|--------|--------|------|
| 输出目录 | 单一 `dist/` | 环境隔离 | ✅ 解决开发污染 |
| 代码组织 | 分散多处 | 统一生成器 | ✅ 消除重复实现 |
| 缓存策略 | 简单文件检查 | TTL + 智能管理 | ✅ 企业级缓存 |
| 并发控制 | Promise.all | 批量 + 限流 | ✅ 性能优化 |
| 错误处理 | 基础 try/catch | 分类 + 重试 | ✅ 健壮性提升 |
| 开发体验 | 基础日志 | 详细进度 + 统计 | ✅ 可观察性 |

## 最佳实践

### 1. 环境配置
```typescript
const config = {
  outputDir: {
    production: 'dist/client',
    development: '.ssg-cache',  // 关键：独立开发目录
  },
  caching: {
    enabled: true,
    ttl: process.env.NODE_ENV === 'production' ? 3600 : 300,
  }
};
```

### 2. 路由发现
```typescript
const ssgManager = new SSGManager({
  routeDiscovery: {
    enabled: true,
    sources: ['filesystem', 'config'],
    patterns: ['src/pages/**/*'],
    exclude: ['/api/*', '/admin/*'],
  }
});
```

### 3. 开发工作流
```typescript
// 开发模式
const ssgManager = new SSGManager({
  development: {
    hotReload: true,
    watchFiles: true,
    watchPatterns: ['src/pages/**/*', 'src/components/**/*'],
  }
});
```

### 4. 生产构建
```typescript
// 生产构建
const ssgManager = new SSGManager({
  cleanupOldFiles: true,  // 清理旧文件
  concurrent: 5,          // 提高并发
  buildIntegration: {
    enabled: true,
    prebuildHook: async () => {
      // 执行其他构建任务
    },
    postbuildHook: async (results) => {
      // 上传到 CDN 等后处理
    }
  }
});
```

## 性能对比

### 生成性能
- **并发控制**: 从无限并发改为可控批量处理
- **内存管理**: 避免大量页面同时加载内存
- **缓存命中**: 智能缓存减少重复生成

### 开发体验  
- **热重载**: 文件变化时智能重新生成
- **进度提示**: 详细的生成进度和统计信息
- **错误恢复**: 单个页面失败不影响整体构建

## 向后兼容性

### 现有代码兼容
- ✅ `SSGModule` 类接口保持不变
- ✅ 现有配置文件继续有效  
- ✅ 生成的 HTML 格式一致
- ⚠️  需要调用 `setRenderFunction()` 设置渲染函数

### 渐进式迁移
1. **阶段 1**: 继续使用重构后的 `SSGModule`
2. **阶段 2**: 逐步迁移到 `SSGManager` 
3. **阶段 3**: 启用高级功能（路由发现、文件监听等）

## 故障排除

### 常见问题

#### 1. 开发模式下找不到静态文件
**原因**: 文件现在生成到 `.ssg-cache/` 目录
**解决**: 确保服务器配置正确处理缓存目录

#### 2. 渲染函数未设置错误
**错误**: `渲染函数未设置，请调用 setRenderFunction`
**解决**: 在调用生成方法前设置渲染函数
```typescript
ssg.setRenderFunction(renderFunction);
```

#### 3. 权限错误
**原因**: 无法写入 `.ssg-cache/` 目录
**解决**: 检查目录权限，确保可写

### 调试技巧

#### 启用详细日志
```typescript
const ssgManager = new SSGManager(config, true); // 第二个参数启用详细日志
```

#### 检查生成统计
```typescript
const stats = ssgManager.getStats();
console.log('SSG统计:', stats);
```

#### 清理缓存
```typescript
await ssgManager.cleanup(); // 清理所有缓存和资源
```

## 总结

新的 SSG 实现通过统一的生成器和环境隔离，彻底解决了双实现重复和开发污染问题：

- ✅ **统一实现**: 消除重复代码，易于维护
- ✅ **环境隔离**: 开发和生产完全分离
- ✅ **企业级功能**: 缓存、并发、监控一应俱全
- ✅ **向后兼容**: 现有代码无需大幅修改
- ✅ **渐进迁移**: 可以逐步升级到新功能

建议在新项目中直接使用 `SSGManager`，在现有项目中可以先使用重构后的 `SSGModule` 确保兼容性，然后逐步迁移。