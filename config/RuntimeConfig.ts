/**
 * 运行时配置管理系统
 * 提供动态配置更新、环境变量集成、配置验证等功能
 */

import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { Logger } from '../utils/Logger';

export interface ConfigSchema {
  [key: string]: {
    type: 'string' | 'number' | 'boolean' | 'object' | 'array';
    required?: boolean;
    default?: any;
    validation?: (value: any) => boolean;
    description?: string;
    sensitive?: boolean; // 标记敏感信息
  };
}

export interface RuntimeConfigOptions {
  configFile?: string;
  watchForChanges?: boolean;
  enableRemoteConfig?: boolean;
  remoteConfigUrl?: string;
  refreshInterval?: number;
  schema?: ConfigSchema;
  verbose?: boolean;
}

/**
 * 运行时配置管理器
 */
export class RuntimeConfigManager extends EventEmitter {
  private config: Record<string, any> = {};
  private schema: ConfigSchema = {};
  private options: RuntimeConfigOptions;
  private logger: Logger;
  private watchers: fs.FSWatcher[] = [];
  private refreshTimer?: NodeJS.Timeout;
  private lastModified: Map<string, number> = new Map();

  constructor(options: RuntimeConfigOptions = {}) {
    super();
    
    this.options = {
      configFile: './config.json',
      watchForChanges: true,
      enableRemoteConfig: false,
      refreshInterval: 60000, // 1分钟
      ...options,
    };
    
    this.logger = new Logger(this.options.verbose);
    
    if (this.options.schema) {
      this.schema = this.options.schema;
    }
  }

  /**
   * 初始化配置管理器
   */
  async initialize(): Promise<void> {
    this.logger.info('初始化运行时配置管理器...');
    
    try {
      // 加载配置文件
      if (this.options.configFile) {
        await this.loadConfigFile(this.options.configFile);
      }
      
      // 加载环境变量
      this.loadEnvironmentVariables();
      
      // 验证配置
      const validation = this.validateConfig();
      if (!validation.isValid) {
        this.logger.warn('配置验证失败:', validation.errors);
      }
      
      // 启动文件监听
      if (this.options.watchForChanges && this.options.configFile) {
        this.startFileWatcher();
      }
      
      // 启动远程配置
      if (this.options.enableRemoteConfig) {
        await this.startRemoteConfigRefresh();
      }
      
      this.logger.info('运行时配置管理器初始化完成');
      this.emit('initialized', this.config);
      
    } catch (error) {
      this.logger.error('配置管理器初始化失败:', error);
      throw error;
    }
  }

  /**
   * 加载配置文件
   */
  private async loadConfigFile(configPath: string): Promise<void> {
    try {
      const fullPath = path.resolve(configPath);
      
      if (!fs.existsSync(fullPath)) {
        this.logger.warn(`配置文件不存在: ${fullPath}`);
        return;
      }
      
      const stats = fs.statSync(fullPath);
      const content = await fs.promises.readFile(fullPath, 'utf-8');
      
      let fileConfig: Record<string, any>;
      
      if (fullPath.endsWith('.json')) {
        fileConfig = JSON.parse(content);
      } else if (fullPath.endsWith('.js')) {
        // 动态导入JS配置文件
        delete require.cache[require.resolve(fullPath)];
        fileConfig = require(fullPath);
        if (typeof fileConfig === 'function') {
          fileConfig = fileConfig();
        }
      } else {
        throw new Error(`不支持的配置文件格式: ${fullPath}`);
      }
      
      // 合并配置
      this.config = { ...this.config, ...fileConfig };
      this.lastModified.set(fullPath, stats.mtime.getTime());
      
      this.logger.debug(`已加载配置文件: ${fullPath}`);
      this.emit('fileLoaded', fullPath, fileConfig);
      
    } catch (error) {
      this.logger.error(`加载配置文件失败: ${configPath}`, error);
      throw error;
    }
  }

  /**
   * 加载环境变量
   */
  private loadEnvironmentVariables(): void {
    const envConfig: Record<string, any> = {};
    const prefix = 'NOVEL_ISR_';
    
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith(prefix)) {
        const configKey = key.substring(prefix.length).toLowerCase().replace(/_/g, '.');
        envConfig[configKey] = this.parseEnvironmentValue(value!);
      }
    }
    
    if (Object.keys(envConfig).length > 0) {
      this.config = { ...this.config, ...this.flattenObject(envConfig) };
      this.logger.debug(`已加载 ${Object.keys(envConfig).length} 个环境变量`);
      this.emit('environmentLoaded', envConfig);
    }
  }

  /**
   * 解析环境变量值
   */
  private parseEnvironmentValue(value: string): any {
    // 尝试解析为JSON
    try {
      return JSON.parse(value);
    } catch {
      // 解析为基本类型
      if (value.toLowerCase() === 'true') return true;
      if (value.toLowerCase() === 'false') return false;
      if (/^\d+$/.test(value)) return parseInt(value, 10);
      if (/^\d*\.\d+$/.test(value)) return parseFloat(value);
      return value;
    }
  }

  /**
   * 扁平化对象（用于环境变量）
   */
  private flattenObject(obj: Record<string, any>, prefix = ''): Record<string, any> {
    const result: Record<string, any> = {};
    
    for (const [key, value] of Object.entries(obj)) {
      const newKey = prefix ? `${prefix}.${key}` : key;
      
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        Object.assign(result, this.flattenObject(value, newKey));
      } else {
        result[newKey] = value;
      }
    }
    
    return result;
  }

  /**
   * 启动文件监听
   */
  private startFileWatcher(): void {
    if (!this.options.configFile) return;
    
    try {
      const configPath = path.resolve(this.options.configFile);
      const configDir = path.dirname(configPath);
      
      const watcher = fs.watch(configDir, async (eventType, filename) => {
        if (filename && path.join(configDir, filename) === configPath) {
          this.logger.debug(`配置文件发生变化: ${eventType} - ${filename}`);
          
          try {
            // 防抖处理
            await new Promise(resolve => setTimeout(resolve, 100));
            await this.reloadConfig();
          } catch (error) {
            this.logger.error('重新加载配置失败:', error);
            this.emit('reloadError', error);
          }
        }
      });
      
      this.watchers.push(watcher);
      this.logger.debug('已启动配置文件监听');
      
    } catch (error) {
      this.logger.error('启动配置文件监听失败:', error);
    }
  }

  /**
   * 启动远程配置刷新
   */
  private async startRemoteConfigRefresh(): Promise<void> {
    if (!this.options.remoteConfigUrl) {
      this.logger.warn('远程配置URL未设置');
      return;
    }
    
    // 立即加载一次
    await this.loadRemoteConfig();
    
    // 设置定时刷新
    if (this.options.refreshInterval && this.options.refreshInterval > 0) {
      this.refreshTimer = setInterval(async () => {
        try {
          await this.loadRemoteConfig();
        } catch (error) {
          this.logger.error('远程配置刷新失败:', error);
        }
      }, this.options.refreshInterval);
      
      this.logger.debug(`已启动远程配置刷新，间隔: ${this.options.refreshInterval}ms`);
    }
  }

  /**
   * 加载远程配置
   */
  private async loadRemoteConfig(): Promise<void> {
    if (!this.options.remoteConfigUrl) return;
    
    try {
      const fetch = (await import('node-fetch')).default;
      // 创建一个带超时的AbortController
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      
      const response = await fetch(this.options.remoteConfigUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Novel-ISR-Engine/1.0',
        },
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const remoteConfig = await response.json() as Record<string, any>;
      const oldConfig = { ...this.config };
      
      // 合并远程配置
      this.config = { ...this.config, ...remoteConfig };
      
      // 检查是否有变化
      const hasChanges = JSON.stringify(oldConfig) !== JSON.stringify(this.config);
      
      if (hasChanges) {
        this.logger.info('远程配置已更新');
        this.emit('remoteConfigUpdated', remoteConfig, oldConfig);
        this.emit('configChanged', this.config, oldConfig);
      }
      
    } catch (error) {
      this.logger.error('加载远程配置失败:', error);
      this.emit('remoteConfigError', error);
    }
  }

  /**
   * 重新加载配置
   */
  async reloadConfig(): Promise<void> {
    const oldConfig = { ...this.config };
    
    try {
      // 重新加载配置文件
      if (this.options.configFile) {
        await this.loadConfigFile(this.options.configFile);
      }
      
      // 重新加载环境变量
      this.loadEnvironmentVariables();
      
      // 验证配置
      const validation = this.validateConfig();
      if (!validation.isValid) {
        this.logger.warn('配置重新加载后验证失败:', validation.errors);
      }
      
      this.logger.info('配置已重新加载');
      this.emit('configReloaded', this.config, oldConfig);
      this.emit('configChanged', this.config, oldConfig);
      
    } catch (error) {
      // 恢复旧配置
      this.config = oldConfig;
      this.logger.error('配置重新加载失败，已恢复旧配置:', error);
      throw error;
    }
  }

  /**
   * 验证配置
   */
  validateConfig(): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];
    
    for (const [key, schemaItem] of Object.entries(this.schema)) {
      const value = this.get(key);
      
      // 检查必需字段
      if (schemaItem.required && (value === undefined || value === null)) {
        errors.push(`必需字段缺失: ${key}`);
        continue;
      }
      
      // 如果值不存在且不是必需的，使用默认值
      if ((value === undefined || value === null) && schemaItem.default !== undefined) {
        this.set(key, schemaItem.default);
        continue;
      }
      
      // 类型检查
      if (value !== undefined && value !== null) {
        const actualType = Array.isArray(value) ? 'array' : typeof value;
        if (actualType !== schemaItem.type) {
          errors.push(`字段类型错误: ${key} 应为 ${schemaItem.type}，实际为 ${actualType}`);
        }
      }
      
      // 自定义验证
      if (schemaItem.validation && value !== undefined && value !== null) {
        try {
          if (!schemaItem.validation(value)) {
            errors.push(`字段验证失败: ${key}`);
          }
        } catch (validationError) {
          errors.push(`字段验证异常: ${key} - ${validationError}`);
        }
      }
    }
    
    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * 获取配置值
   */
  get<T = any>(key: string, defaultValue?: T): T {
    const keys = key.split('.');
    let value = this.config;
    
    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k];
      } else {
        return defaultValue as T;
      }
    }
    
    return value as T;
  }

  /**
   * 设置配置值
   */
  set(key: string, value: any): void {
    const keys = key.split('.');
    const lastKey = keys.pop()!;
    let target = this.config;
    
    for (const k of keys) {
      if (!target[k] || typeof target[k] !== 'object') {
        target[k] = {};
      }
      target = target[k];
    }
    
    const oldValue = target[lastKey];
    target[lastKey] = value;
    
    this.emit('configValueChanged', key, value, oldValue);
  }

  /**
   * 检查配置项是否存在
   */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * 删除配置项
   */
  delete(key: string): boolean {
    const keys = key.split('.');
    const lastKey = keys.pop()!;
    let target = this.config;
    
    for (const k of keys) {
      if (!target[k] || typeof target[k] !== 'object') {
        return false;
      }
      target = target[k];
    }
    
    if (lastKey in target) {
      const oldValue = target[lastKey];
      delete target[lastKey];
      this.emit('configValueDeleted', key, oldValue);
      return true;
    }
    
    return false;
  }

  /**
   * 获取所有配置
   */
  getAll(): Record<string, any> {
    return { ...this.config };
  }

  /**
   * 获取安全配置（隐藏敏感信息）
   */
  getSafeConfig(): Record<string, any> {
    const safeConfig = { ...this.config };
    
    for (const [key, schemaItem] of Object.entries(this.schema)) {
      if (schemaItem.sensitive && this.has(key)) {
        this.maskSensitiveValue(safeConfig, key);
      }
    }
    
    return safeConfig;
  }

  /**
   * 掩码敏感值
   */
  private maskSensitiveValue(obj: any, key: string): void {
    const keys = key.split('.');
    const lastKey = keys.pop()!;
    let target = obj;
    
    for (const k of keys) {
      if (!target[k]) return;
      target = target[k];
    }
    
    if (target[lastKey]) {
      const value = String(target[lastKey]);
      target[lastKey] = value.length > 4 ? 
        `${value.substring(0, 2)}${'*'.repeat(value.length - 4)}${value.substring(value.length - 2)}` :
        '***';
    }
  }

  /**
   * 导出配置到文件
   */
  async exportConfig(filePath: string, safe = true): Promise<void> {
    try {
      const configToExport = safe ? this.getSafeConfig() : this.getAll();
      const content = JSON.stringify(configToExport, null, 2);
      
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, content, 'utf-8');
      
      this.logger.info(`配置已导出到: ${filePath}`);
      
    } catch (error) {
      this.logger.error(`配置导出失败: ${filePath}`, error);
      throw error;
    }
  }

  /**
   * 获取配置统计信息
   */
  getStats(): {
    totalKeys: number;
    requiredKeys: number;
    sensitiveKeys: number;
    lastReloadTime?: number;
  } {
    const totalKeys = Object.keys(this.flattenObject(this.config)).length;
    const requiredKeys = Object.values(this.schema).filter(s => s.required).length;
    const sensitiveKeys = Object.values(this.schema).filter(s => s.sensitive).length;
    
    return {
      totalKeys,
      requiredKeys,
      sensitiveKeys,
      lastReloadTime: Math.max(...this.lastModified.values()) || undefined,
    };
  }

  /**
   * 关闭配置管理器
   */
  async shutdown(): Promise<void> {
    this.logger.info('关闭运行时配置管理器...');
    
    // 停止文件监听
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers.length = 0;
    
    // 停止远程配置刷新
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    
    // 移除所有监听器
    this.removeAllListeners();
    
    this.logger.info('运行时配置管理器已关闭');
  }
}

/**
 * 配置模板生成器
 */
export class ConfigTemplateGenerator {
  static generateTemplate(schema: ConfigSchema): Record<string, any> {
    const template: Record<string, any> = {};
    
    for (const [key, schemaItem] of Object.entries(schema)) {
      if (schemaItem.default !== undefined) {
        template[key] = schemaItem.default;
      } else {
        switch (schemaItem.type) {
          case 'string':
            template[key] = schemaItem.description || `<${key}>`;
            break;
          case 'number':
            template[key] = 0;
            break;
          case 'boolean':
            template[key] = false;
            break;
          case 'array':
            template[key] = [];
            break;
          case 'object':
            template[key] = {};
            break;
        }
      }
    }
    
    return template;
  }
  
  static generateDocumentation(schema: ConfigSchema): string {
    let doc = '# 配置文档\n\n';
    
    for (const [key, schemaItem] of Object.entries(schema)) {
      doc += `## ${key}\n`;
      doc += `- **类型**: ${schemaItem.type}\n`;
      doc += `- **必需**: ${schemaItem.required ? '是' : '否'}\n`;
      
      if (schemaItem.default !== undefined) {
        doc += `- **默认值**: \`${JSON.stringify(schemaItem.default)}\`\n`;
      }
      
      if (schemaItem.description) {
        doc += `- **描述**: ${schemaItem.description}\n`;
      }
      
      if (schemaItem.sensitive) {
        doc += `- **敏感信息**: 是\n`;
      }
      
      doc += '\n';
    }
    
    return doc;
  }
}

