/**
 * SEO模块增强功能
 * 提供自动化SEO优化、站点地图生成、robots.txt管理等功能
 */

import fs from 'fs';
import path from 'path';
import { SitemapStream, streamToPromise } from 'sitemap';
import { Logger } from '../utils/Logger';

export interface SitemapEntry {
  url: string;
  changefreq?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
  priority?: number;
  lastmod?: string;
  img?: Array<{
    url: string;
    caption?: string;
    title?: string;
  }>;
  links?: Array<{
    lang: string;
    url: string;
  }>;
}

export interface RobotsRule {
  userAgent: string;
  disallow?: string[];
  allow?: string[];
  crawlDelay?: number;
}

export interface SeoConfig {
  baseUrl: string;
  sitemap: {
    enabled: boolean;
    filename: string;
    routes: SitemapEntry[];
    autoDiscovery: boolean;
  };
  robots: {
    enabled: boolean;
    rules: RobotsRule[];
    sitemapUrl?: string;
  };
  redirects: Array<{
    from: string;
    to: string;
    status: number;
    permanent?: boolean;
  }>;
  canonicalization: {
    enabled: boolean;
    trailingSlash: 'add' | 'remove' | 'ignore';
    wwwRedirect: 'add' | 'remove' | 'ignore';
  };
}

/**
 * 增强版sitemap生成器
 */
export class SitemapGenerator {
  private config: SeoConfig;
  private logger: Logger;
  private routes: Set<string> = new Set();

  constructor(config: SeoConfig, verbose = false) {
    this.config = config;
    this.logger = new Logger(verbose);
  }

  /**
   * 添加路由到sitemap
   */
  addRoute(entry: SitemapEntry): void {
    this.routes.add(entry.url);
    
    // 更新配置中的routes
    const existingIndex = this.config.sitemap.routes.findIndex(
      route => route.url === entry.url
    );
    
    if (existingIndex >= 0) {
      this.config.sitemap.routes[existingIndex] = entry;
    } else {
      this.config.sitemap.routes.push(entry);
    }
  }

  /**
   * 从路由配置自动发现路由
   */
  async autoDiscoverRoutes(routeConfigPath?: string): Promise<void> {
    if (!this.config.sitemap.autoDiscovery) {
      return;
    }

    try {
      // 尝试从多个可能的位置读取路由配置
      const possiblePaths = [
        routeConfigPath,
        './src/config/routes.tsx',
        './src/config/routes.ts',
        './src/routes.tsx',
        './src/routes.ts',
      ].filter(Boolean) as string[];

      for (const configPath of possiblePaths) {
        try {
          const fullPath = path.resolve(configPath);
          if (fs.existsSync(fullPath)) {
            await this.parseRouteConfig(fullPath);
            break;
          }
        } catch (error) {
          this.logger.debug(`无法读取路由配置: ${configPath}`);
        }
      }
    } catch (error) {
      this.logger.warn('自动发现路由失败:', error);
    }
  }

  private async parseRouteConfig(configPath: string): Promise<void> {
    try {
      // 这里需要实际解析路由配置文件
      // 由于路由配置可能是React组件，需要特殊处理
      const content = await fs.promises.readFile(configPath, 'utf-8');
      
      // 简单的正则匹配路径（实际应用中可能需要更复杂的解析）
      const pathMatches = content.match(/path:\s*['"`]([^'"`]+)['"`]/g);
      
      if (pathMatches) {
        for (const match of pathMatches) {
          const pathMatch = match.match(/['"`]([^'"`]+)['"`]/);
          if (pathMatch) {
            const routePath = pathMatch[1];
            
            // 跳过动态路由和通配符
            if (!routePath.includes(':') && !routePath.includes('*')) {
              this.addRoute({
                url: routePath,
                changefreq: 'weekly',
                priority: routePath === '/' ? 1.0 : 0.8,
              });
            }
          }
        }
      }
      
      this.logger.debug(`从 ${configPath} 发现了 ${pathMatches?.length || 0} 个路由`);
    } catch (error) {
      this.logger.error('解析路由配置失败:', error);
    }
  }

  /**
   * 生成sitemap.xml
   */
  async generateSitemap(): Promise<string> {
    if (!this.config.sitemap.enabled) {
      throw new Error('Sitemap生成未启用');
    }

    const stream = new SitemapStream({ 
      hostname: this.config.baseUrl,
    });

    // 添加所有路由
    for (const entry of this.config.sitemap.routes) {
      stream.write({
        url: entry.url,
        changefreq: entry.changefreq || 'weekly',
        priority: entry.priority || 0.8,
        lastmod: entry.lastmod,
        img: entry.img,
        links: entry.links,
      });
    }

    stream.end();
    
    const xmlBuffer = await streamToPromise(stream);
    const xmlString = xmlBuffer.toString();
    
    this.logger.info(`生成sitemap，包含 ${this.config.sitemap.routes.length} 个URL`);
    return xmlString;
  }

  /**
   * 生成sitemap索引文件（用于大型站点）
   */
  async generateSitemapIndex(sitemapUrls: string[]): Promise<string> {
    const entries = sitemapUrls.map(url => ({
      url,
      lastmod: new Date().toISOString(),
    }));

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
    
    for (const entry of entries) {
      xml += '  <sitemap>\n';
      xml += `    <loc>${entry.url}</loc>\n`;
      xml += `    <lastmod>${entry.lastmod}</lastmod>\n`;
      xml += '  </sitemap>\n';
    }
    
    xml += '</sitemapindex>\n';
    
    return xml;
  }

  /**
   * 保存sitemap到文件
   */
  async saveSitemap(outputPath: string): Promise<void> {
    const xml = await this.generateSitemap();
    const fullPath = path.resolve(outputPath, this.config.sitemap.filename);
    
    // 确保目录存在
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, xml, 'utf-8');
    
    this.logger.info(`Sitemap已保存到: ${fullPath}`);
  }

  /**
   * 验证sitemap
   */
  async validateSitemap(): Promise<{ isValid: boolean; issues: string[] }> {
    const issues: string[] = [];
    
    // 检查URL数量限制
    if (this.config.sitemap.routes.length > 50000) {
      issues.push('Sitemap包含超过50,000个URL，建议使用sitemap索引');
    }

    // 检查URL格式
    for (const entry of this.config.sitemap.routes) {
      try {
        new URL(entry.url, this.config.baseUrl);
      } catch {
        issues.push(`无效的URL: ${entry.url}`);
      }

      // 检查优先级
      if (entry.priority !== undefined && (entry.priority < 0 || entry.priority > 1)) {
        issues.push(`URL ${entry.url} 的优先级无效: ${entry.priority}`);
      }
    }

    return {
      isValid: issues.length === 0,
      issues,
    };
  }
}

/**
 * Robots.txt生成器
 */
export class RobotsGenerator {
  private config: SeoConfig;
  private logger: Logger;

  constructor(config: SeoConfig, verbose = false) {
    this.config = config;
    this.logger = new Logger(verbose);
  }

  /**
   * 生成robots.txt内容
   */
  generateRobots(): string {
    if (!this.config.robots.enabled) {
      return '# Robots.txt generation is disabled\n';
    }

    let content = '# Robots.txt generated by Novel ISR Engine\n';
    content += `# Generated on ${new Date().toISOString()}\n\n`;

    // 添加用户代理规则
    for (const rule of this.config.robots.rules) {
      content += `User-agent: ${rule.userAgent}\n`;
      
      if (rule.disallow) {
        for (const path of rule.disallow) {
          content += `Disallow: ${path}\n`;
        }
      }
      
      if (rule.allow) {
        for (const path of rule.allow) {
          content += `Allow: ${path}\n`;
        }
      }
      
      if (rule.crawlDelay) {
        content += `Crawl-delay: ${rule.crawlDelay}\n`;
      }
      
      content += '\n';
    }

    // 添加sitemap链接
    if (this.config.robots.sitemapUrl) {
      content += `Sitemap: ${this.config.robots.sitemapUrl}\n`;
    } else if (this.config.sitemap.enabled) {
      const sitemapUrl = `${this.config.baseUrl}/${this.config.sitemap.filename}`;
      content += `Sitemap: ${sitemapUrl}\n`;
    }

    return content;
  }

  /**
   * 保存robots.txt到文件
   */
  async saveRobots(outputPath: string): Promise<void> {
    const content = this.generateRobots();
    const fullPath = path.resolve(outputPath, 'robots.txt');
    
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, content, 'utf-8');
    
    this.logger.info(`Robots.txt已保存到: ${fullPath}`);
  }
}

/**
 * 重定向管理器
 */
export class RedirectManager {
  private config: SeoConfig;
  private logger: Logger;

  constructor(config: SeoConfig, verbose = false) {
    this.config = config;
    this.logger = new Logger(verbose);
  }

  /**
   * 检查是否需要重定向
   */
  checkRedirect(url: string): { shouldRedirect: boolean; redirectTo?: string; status?: number } {
    // 检查预定义重定向
    for (const redirect of this.config.redirects) {
      if (this.matchUrl(url, redirect.from)) {
        return {
          shouldRedirect: true,
          redirectTo: redirect.to,
          status: redirect.status,
        };
      }
    }

    // 检查规范化规则
    const canonicalRedirect = this.checkCanonicalization(url);
    if (canonicalRedirect.shouldRedirect) {
      return canonicalRedirect;
    }

    return { shouldRedirect: false };
  }

  private matchUrl(url: string, pattern: string): boolean {
    // 支持简单的通配符匹配
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      return regex.test(url);
    }
    return url === pattern;
  }

  private checkCanonicalization(url: string): { shouldRedirect: boolean; redirectTo?: string; status?: number } {
    if (!this.config.canonicalization.enabled) {
      return { shouldRedirect: false };
    }

    try {
      const urlObj = new URL(url, this.config.baseUrl);
      let modified = false;
      
      // 处理尾部斜杠
      if (this.config.canonicalization.trailingSlash === 'add') {
        if (!urlObj.pathname.endsWith('/') && !path.extname(urlObj.pathname)) {
          urlObj.pathname += '/';
          modified = true;
        }
      } else if (this.config.canonicalization.trailingSlash === 'remove') {
        if (urlObj.pathname.endsWith('/') && urlObj.pathname !== '/') {
          urlObj.pathname = urlObj.pathname.slice(0, -1);
          modified = true;
        }
      }

      // 处理www重定向
      if (this.config.canonicalization.wwwRedirect === 'add') {
        if (!urlObj.hostname.startsWith('www.')) {
          urlObj.hostname = `www.${urlObj.hostname}`;
          modified = true;
        }
      } else if (this.config.canonicalization.wwwRedirect === 'remove') {
        if (urlObj.hostname.startsWith('www.')) {
          urlObj.hostname = urlObj.hostname.substring(4);
          modified = true;
        }
      }

      if (modified) {
        return {
          shouldRedirect: true,
          redirectTo: urlObj.toString(),
          status: 301,
        };
      }
    } catch (error) {
      this.logger.error('规范化检查失败:', error);
    }

    return { shouldRedirect: false };
  }

  /**
   * 添加重定向规则
   */
  addRedirect(from: string, to: string, status = 301, permanent = false): void {
    this.config.redirects.push({
      from,
      to,
      status,
      permanent,
    });
    
    this.logger.debug(`添加重定向规则: ${from} -> ${to} (${status})`);
  }

  /**
   * 生成重定向配置（用于web服务器）
   */
  generateRedirectConfig(format: 'nginx' | 'apache' | 'json' = 'json'): string {
    switch (format) {
      case 'nginx':
        return this.generateNginxConfig();
      case 'apache':
        return this.generateApacheConfig();
      case 'json':
      default:
        return JSON.stringify(this.config.redirects, null, 2);
    }
  }

  private generateNginxConfig(): string {
    let config = '# Nginx redirects generated by Novel ISR Engine\n\n';
    
    for (const redirect of this.config.redirects) {
      const permanent = redirect.status === 301 ? ' permanent' : '';
      config += `rewrite ^${this.escapeRegex(redirect.from)}$ ${redirect.to}${permanent};\n`;
    }
    
    return config;
  }

  private generateApacheConfig(): string {
    let config = '# Apache redirects generated by Novel ISR Engine\n\n';
    
    for (const redirect of this.config.redirects) {
      const flag = redirect.status === 301 ? 'R=301,L' : 'R,L';
      config += `RewriteRule ^${this.escapeRegex(redirect.from)}$ ${redirect.to} [${flag}]\n`;
    }
    
    return config;
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

/**
 * SEO综合管理器
 */
export class SeoManager {
  private sitemapGenerator: SitemapGenerator;
  private robotsGenerator: RobotsGenerator;
  private redirectManager: RedirectManager;
  private config: SeoConfig;
  private logger: Logger;

  constructor(config: SeoConfig, verbose = false) {
    this.config = config;
    this.logger = new Logger(verbose);
    
    this.sitemapGenerator = new SitemapGenerator(config, verbose);
    this.robotsGenerator = new RobotsGenerator(config, verbose);
    this.redirectManager = new RedirectManager(config, verbose);
  }

  async initialize(): Promise<void> {
    this.logger.info('初始化SEO管理器...');
    
    // 自动发现路由
    if (this.config.sitemap.autoDiscovery) {
      await this.sitemapGenerator.autoDiscoverRoutes();
    }
    
    this.logger.info('SEO管理器初始化完成');
  }

  async generateAllFiles(outputPath: string): Promise<void> {
    const promises: Promise<void>[] = [];
    
    if (this.config.sitemap.enabled) {
      promises.push(this.sitemapGenerator.saveSitemap(outputPath));
    }
    
    if (this.config.robots.enabled) {
      promises.push(this.robotsGenerator.saveRobots(outputPath));
    }
    
    await Promise.all(promises);
    this.logger.info('所有SEO文件生成完成');
  }

  getSitemapGenerator(): SitemapGenerator {
    return this.sitemapGenerator;
  }

  getRobotsGenerator(): RobotsGenerator {
    return this.robotsGenerator;
  }

  getRedirectManager(): RedirectManager {
    return this.redirectManager;
  }

  async validateSeoSetup(): Promise<{ isValid: boolean; issues: string[] }> {
    const issues: string[] = [];
    
    // 验证基础配置
    if (!this.config.baseUrl) {
      issues.push('baseUrl未配置');
    } else {
      try {
        new URL(this.config.baseUrl);
      } catch {
        issues.push('baseUrl格式无效');
      }
    }
    
    // 验证sitemap
    if (this.config.sitemap.enabled) {
      const sitemapValidation = await this.sitemapGenerator.validateSitemap();
      if (!sitemapValidation.isValid) {
        issues.push(...sitemapValidation.issues);
      }
    }
    
    return {
      isValid: issues.length === 0,
      issues,
    };
  }
}

// Classes are already exported above, no need for duplicate exports