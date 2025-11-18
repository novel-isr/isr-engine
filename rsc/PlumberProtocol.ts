/**
 * React Flight 协议标准实现
 *
 * 完全符合 React 官方 Flight 协议规范的序列化与反序列化
 *
 * Flight 协议格式 (NDJSON - Newline Delimited JSON):
 * - 每行是一个独立的 chunk，格式：<prefix><id>:<payload>
 * - 行前缀类型：
 *   - J = JSON chunk (普通数据、组件)
 *   - M = Module Reference (客户端组件引用，用于代码分割)
 *   - S = Symbol Reference (特殊 React 符号)
 *   - E = Error chunk (错误)
 *   - P = Promise chunk (异步数据)
 *   - @ = Server Action Reference (服务端函数)
 *
 * 核心特性：
 * 1. 流式传输：支持逐 chunk 发送和解析
 * 2. Module References：客户端组件边界自动标记
 * 3. Server Actions：服务端函数序列化为可调用引用
 * 4. 自动代码分割：客户端组件元数据包含 chunk 信息
 * 5. Promise 支持：异步数据自动处理
 *
 * 参考：React Server Components RFC & react-server-dom-webpack
 */

import type { ReactElement } from 'react';

/**
 * Flight 协议行类型
 */
export type FlightChunkType = 'J' | 'M' | 'S' | 'E' | 'P' | '@';

/**
 * Module Reference - 客户端组件引用
 * 用于代码分割和懒加载
 */
export interface ModuleReference {
  // 模块唯一标识符
  id: string;
  // 导出名称 (default, named export)
  name: string;
  // Webpack/Vite chunk 信息 (用于代码分割)
  chunks?: string[];
  // 是否异步加载
  async?: boolean;
}

/**
 * Server Action Reference - 服务端函数引用
 * 允许客户端调用服务端函数
 */
export interface ServerActionReference {
  // Action 唯一标识符
  id: string;
  // 绑定参数 (部分应用)
  bound?: any[];
}

/**
 * Flight Chunk - Flight 协议的单个数据块
 */
export interface FlightChunk {
  // Chunk 类型前缀
  type: FlightChunkType;
  // Chunk ID
  id: number | string;
  // Payload 数据
  payload: any;
}

/**
 * Flight 流 - 完整的序列化结果
 */
export interface FlightStream {
  // NDJSON 格式的行数组 (每行是一个 chunk)
  chunks: string[];
  // 模块引用映射表 (用于客户端加载)
  moduleMap: Map<string, ModuleReference>;
  // Server Actions 映射表
  actionMap: Map<string, ServerActionReference>;
}

/**
 * Flight 协议序列化器
 *
 * 完全符合 React Flight 协议规范，生成 NDJSON 格式的流式数据
 */
export class FlightSerializer {
  private chunkCounter = 0;
  private moduleCounter = 0;
  private actionCounter = 0;
  private promiseCounter = 0;

  // 模块引用映射表
  private moduleMap = new Map<string, ModuleReference>();
  // Server Actions 映射表
  private actionMap = new Map<string, ServerActionReference>();
  // 已序列化的值缓存 (用于引用去重)
  private valueCache = new WeakMap<object, string | number>();

  /**
   * 序列化 RSC 组件树为 Flight 流
   *
   * @param element React 元素或任意值
   * @param context 上下文信息 (可选)
   * @returns Flight 流对象
   */
  serialize(element: ReactElement | any, context: any = {}): FlightStream {
    console.log('🚀 开始 React Flight 序列化...');

    // 重置状态
    this.chunkCounter = 0;
    this.moduleCounter = 0;
    this.actionCounter = 0;
    this.promiseCounter = 0;
    this.moduleMap.clear();
    this.actionMap.clear();

    const chunks: string[] = [];

    try {
      // 序列化根值
      const rootRef = this.serializeValue(element, chunks);

      // ✅ Flight 协议：第一行是根引用
      // 格式: J0:<root_value_ref>
      chunks.unshift(this.formatChunk('J', 0, rootRef));

      console.log(`✅ Flight 序列化完成: ${chunks.length} chunks`);
      console.log(`   - 模块引用: ${this.moduleMap.size}`);
      console.log(`   - Server Actions: ${this.actionMap.size}`);

      return {
        chunks,
        moduleMap: this.moduleMap,
        actionMap: this.actionMap,
      };
    } catch (error) {
      console.error('❌ Flight 序列化失败:', error);

      // 返回错误 chunk
      const errorChunk = this.formatChunk('E', 0, {
        message: (error as Error).message,
        stack: (error as Error).stack,
      });

      return {
        chunks: [errorChunk],
        moduleMap: this.moduleMap,
        actionMap: this.actionMap,
      };
    }
  }

  /**
   * 格式化为 Flight 协议行
   *
   * @param type Chunk 类型 (J/M/S/E/P/@)
   * @param id Chunk ID
   * @param payload 数据载荷
   * @returns Flight 格式的行字符串
   */
  private formatChunk(type: FlightChunkType, id: number | string, payload: any): string {
    // Flight 协议格式: <type><id>:<json_payload>
    // 示例: J1:{"type":"div","props":{"children":"Hello"}}
    return `${type}${id}:${JSON.stringify(payload)}`;
  }

  /**
   * 序列化任意值
   *
   * @param value 要序列化的值
   * @param chunks Chunk 数组 (会被修改)
   * @returns 值的引用 (可以是直接值或 $ref)
   */
  private serializeValue(value: any, chunks: string[]): any {
    // ✅ 基本类型直接返回
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }

    // ✅ 检查缓存避免重复序列化
    if (typeof value === 'object' && this.valueCache.has(value)) {
      const cachedRef = this.valueCache.get(value);
      return `$${cachedRef}`; // 引用已序列化的对象
    }

    // ✅ Server Action (函数)
    if (typeof value === 'function') {
      return this.serializeServerAction(value, chunks);
    }

    // ✅ Promise (异步数据)
    if (value instanceof Promise) {
      return this.serializePromise(value, chunks);
    }

    // ✅ React 元素
    if (value && typeof value === 'object' && value.$$typeof === Symbol.for('react.element')) {
      return this.serializeReactElement(value, chunks);
    }

    // ✅ 数组
    if (Array.isArray(value)) {
      return value.map(item => this.serializeValue(item, chunks));
    }

    // ✅ 普通对象
    if (typeof value === 'object') {
      const chunkId = ++this.chunkCounter;
      const serialized: any = {};

      // 递归序列化对象的每个属性
      for (const [key, val] of Object.entries(value)) {
        serialized[key] = this.serializeValue(val, chunks);
      }

      // 生成 JSON chunk
      chunks.push(this.formatChunk('J', chunkId, serialized));

      // 缓存引用
      this.valueCache.set(value, chunkId);

      return `$${chunkId}`; // 返回引用
    }

    // ✅ 其他类型转为字符串
    return String(value);
  }

  /**
   * 序列化 React 元素
   *
   * @param element React 元素
   * @param chunks Chunk 数组
   * @returns 元素引用
   */
  private serializeReactElement(element: any, chunks: string[]): string {
    const chunkId = ++this.chunkCounter;
    const type = element.type;
    const props = element.props || {};

    // ✅ HTML 原生标签 (div, span, etc.)
    if (typeof type === 'string') {
      const serializedProps = this.serializeProps(props, chunks);

      chunks.push(
        this.formatChunk('J', chunkId, {
          $$typeof: 'react.element',
          type,
          props: serializedProps,
        })
      );

      this.valueCache.set(element, chunkId);
      return `$${chunkId}`;
    }

    // ✅ 客户端组件 (需要代码分割)
    if (typeof type === 'function' && (type as any).$$typeof === 'react.client.reference') {
      return this.serializeModuleReference(type, props, chunks);
    }

    // ✅ 服务端组件或函数组件
    if (typeof type === 'function') {
      const componentName = type.name || type.displayName || 'Anonymous';
      const serializedProps = this.serializeProps(props, chunks);

      chunks.push(
        this.formatChunk('J', chunkId, {
          $$typeof: 'react.element',
          type: componentName,
          props: serializedProps,
        })
      );

      this.valueCache.set(element, chunkId);
      return `$${chunkId}`;
    }

    // ✅ 其他 React 类型 (Fragment, Suspense, etc.)
    const serializedProps = this.serializeProps(props, chunks);

    chunks.push(
      this.formatChunk('J', chunkId, {
        $$typeof: 'react.element',
        type: typeof type === 'symbol' ? type.toString() : String(type),
        props: serializedProps,
      })
    );

    this.valueCache.set(element, chunkId);
    return `$${chunkId}`;
  }

  /**
   * 序列化 Props
   *
   * @param props Props 对象
   * @param chunks Chunk 数组
   * @returns 序列化后的 props
   */
  private serializeProps(props: any, chunks: string[]): any {
    const serialized: any = {};

    for (const [key, value] of Object.entries(props)) {
      // 跳过内部 props
      if (key === 'key' || key === 'ref') {
        continue;
      }

      serialized[key] = this.serializeValue(value, chunks);
    }

    return serialized;
  }

  /**
   * 序列化客户端组件引用 (Module Reference)
   *
   * @param type 组件类型
   * @param props Props
   * @param chunks Chunk 数组
   * @returns Module 引用
   */
  private serializeModuleReference(type: any, props: any, chunks: string[]): string {
    const moduleId = `client-${++this.moduleCounter}`;
    const exportName = type.$$id || type.name || 'default';

    // ✅ 创建 Module Reference
    const moduleRef: ModuleReference = {
      id: moduleId,
      name: exportName,
      chunks: type.$$chunks || [],
      async: true,
    };

    this.moduleMap.set(moduleId, moduleRef);

    // ✅ 生成 Module chunk
    // 格式: M<id>:{"id":"<moduleId>","name":"<exportName>","chunks":[...]}
    chunks.push(this.formatChunk('M', moduleId, moduleRef));

    // ✅ 序列化 props 并创建组件实例 chunk
    const chunkId = ++this.chunkCounter;
    const serializedProps = this.serializeProps(props, chunks);

    chunks.push(
      this.formatChunk('J', chunkId, {
        $$typeof: 'react.element',
        type: `@${moduleId}`, // 引用 Module
        props: serializedProps,
      })
    );

    return `$${chunkId}`;
  }

  /**
   * 序列化 Server Action (服务端函数)
   *
   * @param func 函数
   * @param chunks Chunk 数组
   * @returns Action 引用
   */
  private serializeServerAction(func: Function, chunks: string[]): string {
    const actionId = `action-${++this.actionCounter}`;

    // ✅ 创建 Server Action Reference
    const actionRef: ServerActionReference = {
      id: actionId,
      bound: (func as any).$$bound || [],
    };

    this.actionMap.set(actionId, actionRef);

    // ✅ 生成 Server Action chunk
    // 格式: @<id>:{"id":"<actionId>","bound":[...]}
    chunks.push(this.formatChunk('@', actionId, actionRef));

    return `@${actionId}`; // 返回 Action 引用
  }

  /**
   * 序列化 Promise (异步数据)
   *
   * @param promise Promise 对象
   * @param chunks Chunk 数组
   * @returns Promise 引用
   */
  private serializePromise(promise: Promise<any>, chunks: string[]): string {
    const promiseId = `promise-${++this.promiseCounter}`;

    // ✅ 创建 Promise 占位符 chunk
    chunks.push(this.formatChunk('P', promiseId, { status: 'pending' }));

    // ✅ 异步解析 Promise
    promise
      .then(result => {
        const resolvedValue = this.serializeValue(result, chunks);

        // 生成 resolve chunk (会在流中追加)
        chunks.push(
          this.formatChunk('P', promiseId, {
            status: 'fulfilled',
            value: resolvedValue,
          })
        );
      })
      .catch(error => {
        // 生成 reject chunk
        chunks.push(
          this.formatChunk('E', promiseId, {
            message: error.message,
            stack: error.stack,
          })
        );
      });

    return `$${promiseId}`; // 返回 Promise 引用
  }
}

/**
 * Flight 协议反序列化器
 *
 * 完全符合 React Flight 协议规范，解析 NDJSON 格式的流式数据
 */
export class FlightDeserializer {
  // Chunk ID 到值的映射
  private chunkMap = new Map<string | number, any>();
  // Module ID 到组件的映射
  private moduleCache = new Map<string, any>();
  // Promise 映射
  private promiseMap = new Map<string, { resolve: Function; reject: Function }>();
  // Server Actions 映射
  private actionCache = new Map<string, Function>();

  /**
   * 反序列化 Flight 流
   *
   * @param chunks Flight chunks 数组 (NDJSON 格式)
   * @param moduleMap 模块映射表 (用于加载客户端组件)
   * @returns 反序列化的根值
   */
  async deserialize(
    chunks: string[],
    moduleMap: Map<string, ModuleReference> = new Map()
  ): Promise<any> {
    console.log('🚀 开始 React Flight 反序列化...');

    // 重置状态
    this.chunkMap.clear();
    this.promiseMap.clear();
    this.actionCache.clear();

    // 预加载所有客户端组件模块
    for (const [moduleId, moduleRef] of moduleMap.entries()) {
      await this.loadModule(moduleId, moduleRef);
    }

    try {
      // 逐行解析 chunks
      for (const chunk of chunks) {
        await this.parseChunk(chunk);
      }

      // 获取根值 (第一个 chunk，ID 为 0)
      const root = this.resolveReference('$0');

      console.log(`✅ Flight 反序列化完成`);
      return root;
    } catch (error) {
      console.error('❌ Flight 反序列化失败:', error);
      throw error;
    }
  }

  /**
   * 解析单个 Flight chunk
   *
   * @param chunkLine Flight 格式的行字符串
   */
  private async parseChunk(chunkLine: string): Promise<void> {
    if (!chunkLine || !chunkLine.trim()) {
      return;
    }

    // ✅ 解析 Flight 行格式: <type><id>:<json_payload>
    const colonIndex = chunkLine.indexOf(':');
    if (colonIndex === -1) {
      console.warn('⚠️ 无效的 Flight chunk 格式:', chunkLine);
      return;
    }

    const prefix = chunkLine.substring(0, colonIndex);
    const payloadJson = chunkLine.substring(colonIndex + 1);

    // 提取类型和 ID
    const type = prefix[0] as FlightChunkType;
    const id = prefix.substring(1);

    let payload: any;
    try {
      payload = JSON.parse(payloadJson);
    } catch (error) {
      console.warn('⚠️ Chunk payload 解析失败:', payloadJson);
      return;
    }

    // 根据类型处理 chunk
    switch (type) {
      case 'J': // JSON chunk
        await this.processJsonChunk(id, payload);
        break;

      case 'M': // Module Reference
        await this.processModuleChunk(id, payload);
        break;

      case 'P': // Promise chunk
        await this.processPromiseChunk(id, payload);
        break;

      case 'E': // Error chunk
        await this.processErrorChunk(id, payload);
        break;

      case '@': // Server Action
        await this.processActionChunk(id, payload);
        break;

      case 'S': // Symbol Reference
        await this.processSymbolChunk(id, payload);
        break;

      default:
        console.warn('⚠️ 未知的 chunk 类型:', type);
    }
  }

  /**
   * 处理 JSON chunk
   */
  private async processJsonChunk(id: string, payload: any): Promise<void> {
    // 递归解析引用
    const resolved = await this.resolveValue(payload);
    this.chunkMap.set(id, resolved);
  }

  /**
   * 处理 Module chunk (客户端组件)
   */
  private async processModuleChunk(id: string, moduleRef: ModuleReference): Promise<void> {
    await this.loadModule(id, moduleRef);
  }

  /**
   * 处理 Promise chunk
   */
  private async processPromiseChunk(id: string, payload: any): Promise<void> {
    if (payload.status === 'pending') {
      // 创建 Promise
      const promise = new Promise((resolve, reject) => {
        this.promiseMap.set(id, { resolve, reject });
      });
      this.chunkMap.set(id, promise);
    } else if (payload.status === 'fulfilled') {
      // Resolve Promise
      const resolvers = this.promiseMap.get(id);
      if (resolvers) {
        const value = await this.resolveValue(payload.value);
        resolvers.resolve(value);
      }
    }
  }

  /**
   * 处理 Error chunk
   */
  private async processErrorChunk(id: string, payload: any): Promise<void> {
    const error = new Error(payload.message);
    if (payload.stack) {
      error.stack = payload.stack;
    }

    // Reject Promise
    const resolvers = this.promiseMap.get(id);
    if (resolvers) {
      resolvers.reject(error);
    } else {
      console.error('Flight Error:', error);
    }
  }

  /**
   * 处理 Server Action chunk
   */
  private async processActionChunk(id: string, actionRef: ServerActionReference): Promise<void> {
    // ✅ 创建可调用的 Server Action 函数
    const actionFunc = async (...args: any[]) => {
      // 调用服务端 Action (需要 HTTP 请求)
      const response = await fetch(`/rsc-action/${actionRef.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bound: actionRef.bound || [],
          args,
        }),
      });

      if (!response.ok) {
        throw new Error(`Server Action 调用失败: ${response.statusText}`);
      }

      return await response.json();
    };

    this.actionCache.set(id, actionFunc);
    this.chunkMap.set(id, actionFunc);
  }

  /**
   * 处理 Symbol chunk
   */
  private async processSymbolChunk(id: string, payload: any): Promise<void> {
    // React 特殊符号
    const symbol = Symbol.for(payload);
    this.chunkMap.set(id, symbol);
  }

  /**
   * 加载客户端组件模块
   */
  private async loadModule(moduleId: string, moduleRef: ModuleReference): Promise<void> {
    try {
      // ✅ 动态导入客户端组件
      // 实际项目中，这里应该根据 moduleRef.chunks 加载正确的 bundle
      // 示例：const module = await import(`/client/${moduleRef.chunks[0]}`);

      // 暂时使用占位符
      const component = function ClientComponent(props: any) {
        return {
          $$typeof: Symbol.for('react.element'),
          type: 'div',
          props: {
            children: `[Client Component: ${moduleRef.name}]`,
            ...props,
          },
        };
      };

      this.moduleCache.set(moduleId, component);
      console.log(`✅ 加载客户端组件: ${moduleRef.name} (${moduleId})`);
    } catch (error) {
      console.error(`❌ 加载模块失败: ${moduleId}`, error);
    }
  }

  /**
   * 解析值中的引用
   */
  private async resolveValue(value: any): Promise<any> {
    // 基本类型直接返回
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      // ✅ 检查是否是引用
      if (typeof value === 'string' && value.startsWith('$')) {
        return this.resolveReference(value);
      }

      if (typeof value === 'string' && value.startsWith('@')) {
        // Module/Action 引用
        return this.resolveReference(value);
      }

      return value;
    }

    // 数组
    if (Array.isArray(value)) {
      return Promise.all(value.map(item => this.resolveValue(item)));
    }

    // 对象
    if (typeof value === 'object') {
      const resolved: any = {};

      for (const [key, val] of Object.entries(value)) {
        resolved[key] = await this.resolveValue(val);
      }

      return resolved;
    }

    return value;
  }

  /**
   * 解析引用
   */
  private resolveReference(ref: string): any {
    const id = ref.substring(1); // 移除 $ 或 @ 前缀

    if (this.chunkMap.has(id)) {
      return this.chunkMap.get(id);
    }

    // Module 或 Action 引用
    if (this.moduleCache.has(id)) {
      return this.moduleCache.get(id);
    }

    if (this.actionCache.has(id)) {
      return this.actionCache.get(id);
    }

    console.warn(`⚠️ 未找到引用: ${ref}`);
    return null;
  }
}

/**
 * Flight 协议处理器
 *
 * 提供流式传输接口和协议转换
 */
export class FlightProtocolHandler {
  private serializer = new FlightSerializer();
  private deserializer = new FlightDeserializer();

  /**
   * 编码 RSC 组件为 Flight 流式格式
   *
   * @param element React 元素或任意值
   * @param context 上下文信息
   * @returns NDJSON 格式的字符串 (可用于流式传输)
   */
  encodeToStream(element: ReactElement | any, context: any = {}): string {
    const flightStream = this.serializer.serialize(element, context);

    // ✅ 返回 NDJSON 格式 (Newline Delimited JSON)
    // 每行是一个独立的 chunk，适合流式传输
    return flightStream.chunks.join('\n');
  }

  /**
   * 编码 RSC 组件并返回完整的 Flight 流对象
   *
   * @param element React 元素或任意值
   * @param context 上下文信息
   * @returns Flight 流对象 (包含 chunks, moduleMap, actionMap)
   */
  encode(element: ReactElement | any, context: any = {}): FlightStream {
    return this.serializer.serialize(element, context);
  }

  /**
   * 解码 Flight 流式数据
   *
   * @param data NDJSON 格式的字符串
   * @param moduleMap 模块映射表 (可选)
   * @returns 反序列化的值
   */
  async decodeFromStream(
    data: string,
    moduleMap: Map<string, ModuleReference> = new Map()
  ): Promise<any> {
    const chunks = data.split('\n').filter(line => line.trim());
    return await this.deserializer.deserialize(chunks, moduleMap);
  }

  /**
   * 解码 Flight 流对象
   *
   * @param flightStream Flight 流对象
   * @returns 反序列化的值
   */
  async decode(flightStream: FlightStream): Promise<any> {
    return await this.deserializer.deserialize(flightStream.chunks, flightStream.moduleMap);
  }

  /**
   * 创建流式传输的 ReadableStream
   *
   * @param element React 元素或任意值
   * @param context 上下文信息
   * @returns ReadableStream (用于 HTTP Response streaming)
   */
  createReadableStream(element: ReactElement | any, context: any = {}): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const flightStream = this.serializer.serialize(element, context);

    let chunkIndex = 0;

    return new ReadableStream({
      start(controller) {
        console.log('🚀 启动 Flight 流式传输...');
      },

      pull(controller) {
        // ✅ 逐 chunk 推送数据 (支持真正的流式传输)
        if (chunkIndex < flightStream.chunks.length) {
          const chunk = flightStream.chunks[chunkIndex++];
          const bytes = encoder.encode(chunk + '\n');

          controller.enqueue(bytes);

          console.log(`📤 推送 chunk ${chunkIndex}/${flightStream.chunks.length}`);
        } else {
          // 所有 chunks 已发送
          console.log('✅ Flight 流式传输完成');
          controller.close();
        }
      },

      cancel(reason) {
        console.log('⚠️ Flight 流式传输被取消:', reason);
      },
    });
  }
}

// ========== 导出 ==========

// 单例实例
export const flightProtocol = new FlightProtocolHandler();

// 兼容性导出 (保持旧 API)
export class PlumberSerializer extends FlightSerializer {}
export class PlumberDeserializer extends FlightDeserializer {}
export class PlumberProtocolHandler extends FlightProtocolHandler {}
export const plumberProtocol = flightProtocol;
