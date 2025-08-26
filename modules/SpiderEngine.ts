import { URL } from 'url';

import fetch from 'node-fetch';
import pLimit from 'p-limit';

import { Logger } from '../utils/Logger';

/**
 * Advanced Spider Engine for SEO discovery
 */
export class SpiderEngine {
  private config: Record<string, any>;
  private logger: Logger;
  private visited: Set<string>;
  private discovered: Set<string>;
  private errors: Array<{ url: string; error: string }>;
  private robotsCache: Map<string, Record<string, any>>;

  constructor(config: Record<string, any> = {}) {
    this.config = {
      concurrency: config.concurrency || 5,
      delay: config.delay || 1000,
      maxDepth: config.maxDepth || 3,
      maxPages: config.maxPages || 100,
      userAgent: config.userAgent || 'ISR-Engine-Spider/1.0',
      timeout: config.timeout || 10000,
      followRedirects: config.followRedirects !== false,
      respectRobots: config.respectRobots !== false,
      ...config,
    };

    this.logger = new Logger(config.verbose);
    this.visited = new Set();
    this.discovered = new Set();
    this.errors = [];
    this.robotsCache = new Map();
  }

  async crawl(startUrl: string, options: Record<string, any> = {}) {
    this.logger.info(`Starting spider crawl from: ${startUrl}`);

    const baseUrl = new URL(startUrl);
    const limit = pLimit(this.config.concurrency);
    const crawlQueue = [{ url: startUrl, depth: 0 }];
    const results = {
      discoveredUrls: [] as string[],
      seoData: new Map(),
      errors: [] as Array<{ url: string; error: string }>,
      stats: {
        totalPages: 0,
        successfulPages: 0,
        failedPages: 0,
        startTime: Date.now(),
        endTime: 0,
        duration: 0,
      },
    };

    try {
      // Check robots.txt first
      if (this.config.respectRobots) {
        await this.loadRobotsTxt(baseUrl.origin);
      }

      const crawlPromises = [];

      while (
        crawlQueue.length > 0 &&
        results.stats.totalPages < this.config.maxPages
      ) {
        const batch = crawlQueue.splice(0, this.config.concurrency);

        for (const { url, depth } of batch) {
          if (this.visited.has(url) || depth > this.config.maxDepth) {
            continue;
          }

          crawlPromises.push(
            limit(async () => {
              try {
                const pageResult = await this.crawlPage(url, baseUrl, depth);
                if (pageResult) {
                  results.discoveredUrls.push(url);
                  results.seoData.set(url, pageResult.seoData);
                  results.stats.successfulPages++;

                  // Add new URLs to queue
                  (pageResult.links as string[]).forEach((link: string) => {
                    if (
                      !this.visited.has(link) &&
                      this.shouldCrawl(link, baseUrl)
                    ) {
                      crawlQueue.push({ url: link, depth: depth + 1 });
                    }
                  });
                }
              } catch (error) {
                results.errors.push({
                  url,
                  error: (error as any)?.message || error,
                });
                results.stats.failedPages++;
              }

              results.stats.totalPages++;
            })
          );
        }

        // Wait for current batch
        if (crawlPromises.length >= this.config.concurrency) {
          await Promise.allSettled(
            crawlPromises.splice(0, this.config.concurrency)
          );

          // Delay between batches
          if (this.config.delay > 0) {
            await this.sleep(this.config.delay);
          }
        }
      }

      // Wait for remaining promises
      await Promise.allSettled(crawlPromises);

      results.stats.endTime = Date.now();
      results.stats.duration = results.stats.endTime - results.stats.startTime;

      this.logger.info(
        `Spider completed: ${results.stats.successfulPages}/${results.stats.totalPages} pages crawled`
      );

      return results;
    } catch (error) {
      this.logger.error('Spider crawl failed:', error);
      throw error;
    }
  }

  async crawlPage(
    url: string,
    baseUrl: URL,
    depth: number
  ): Promise<{
    url: string;
    links: string[];
    seoData: Record<string, any>;
  } | null> {
    if (this.visited.has(url)) {
      return null;
    }

    this.visited.add(url);
    this.logger.debug(`Crawling: ${url} (depth: ${depth})`);

    try {
      // Check robots.txt permission
      if (this.config.respectRobots && !this.canCrawl(url)) {
        this.logger.debug(`Robots.txt disallows: ${url}`);
        return null;
      }

      const response = await fetch(url, {
        headers: {
          'User-Agent': this.config.userAgent,
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate',
          Connection: 'keep-alive',
        },
        // timeout: this.config.timeout, // node-fetch doesn't support timeout in this way
        // follow: this.config.followRedirects ? 20 : 0
      } as any);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) {
        this.logger.debug(`Skipping non-HTML content: ${url}`);
        return null;
      }

      const html = await response.text();
      const pageData = this.extractPageData(html, url, baseUrl);

      return pageData;
    } catch (error) {
      this.logger.error(
        `Failed to crawl ${url}:`,
        (error as any)?.message || error
      );
      throw error;
    }
  }

  extractPageData(
    html: string,
    url: string,
    baseUrl: URL
  ): { url: string; links: string[]; seoData: Record<string, any> } {
    const links = this.extractLinks(html, url, baseUrl);
    const seoData = this.extractSEOData(html, url);

    return {
      url,
      links: Array.from(links),
      seoData,
    };
  }

  extractLinks(html: string, currentUrl: string, baseUrl: URL): Set<string> {
    const links = new Set<string>();
    const currentUrlObj = new URL(currentUrl);

    // Extract href attributes from anchor tags
    const hrefRegex = /<a[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi;
    let match;

    while ((match = hrefRegex.exec(html)) !== null) {
      try {
        const href = match[1];

        // Skip non-HTTP links
        if (
          href.startsWith('#') ||
          href.startsWith('mailto:') ||
          href.startsWith('tel:') ||
          href.startsWith('javascript:')
        ) {
          continue;
        }

        // Resolve relative URLs
        const absoluteUrl = new URL(href, currentUrl).href;
        const urlObj = new URL(absoluteUrl);

        // Only include same-origin URLs
        if (urlObj.origin === baseUrl.origin) {
          links.add(absoluteUrl);
        }
      } catch (error) {
        // Invalid URL, skip
        continue;
      }
    }

    return links;
  }

  extractSEOData(html: string, url: string): Record<string, any> {
    const seoData = {
      url,
      title: this.extractTitle(html),
      description: this.extractMetaContent(html, 'description'),
      keywords: this.extractMetaContent(html, 'keywords'),
      ogTitle: this.extractMetaProperty(html, 'og:title'),
      ogDescription: this.extractMetaProperty(html, 'og:description'),
      ogImage: this.extractMetaProperty(html, 'og:image'),
      canonicalUrl: this.extractCanonical(html),
      h1: this.extractH1(html),
      h2: this.extractH2(html),
      images: this.extractImages(html),
      wordCount: this.calculateWordCount(html),
      hasStructuredData: this.hasStructuredData(html),
    };

    return seoData;
  }

  extractTitle(html: string): string | null {
    const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    return match ? match[1].trim() : null;
  }

  extractMetaContent(html: string, name: string): string | null {
    const regex = new RegExp(
      `<meta[^>]*name\\s*=\\s*["']${name}["'][^>]*content\\s*=\\s*["']([^"']+)["']`,
      'i'
    );
    const match = html.match(regex);
    return match ? match[1].trim() : null;
  }

  extractMetaProperty(html: string, property: string): string | null {
    const regex = new RegExp(
      `<meta[^>]*property\\s*=\\s*["']${property}["'][^>]*content\\s*=\\s*["']([^"']+)["']`,
      'i'
    );
    const match = html.match(regex);
    return match ? match[1].trim() : null;
  }

  extractCanonical(html: string): string | null {
    const match = html.match(
      /<link[^>]*rel\s*=\s*["']canonical["'][^>]*href\s*=\s*["']([^"']+)["']/i
    );
    return match ? match[1].trim() : null;
  }

  extractH1(html: string): string[] {
    const matches = html.match(/<h1[^>]*>([^<]+)<\/h1>/gi);
    return matches
      ? matches.map((h: string) => h.replace(/<[^>]+>/g, '').trim())
      : [];
  }

  extractH2(html: string): string[] {
    const matches = html.match(/<h2[^>]*>([^<]+)<\/h2>/gi);
    return matches
      ? matches.map((h: string) => h.replace(/<[^>]+>/g, '').trim())
      : [];
  }

  extractImages(html: string): string[] {
    const images = [];
    const imgRegex = /<img[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi;
    let match;

    while ((match = imgRegex.exec(html)) !== null) {
      images.push(match[1]);
    }

    return images;
  }

  calculateWordCount(html: string): number {
    const textContent = html
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return textContent.split(' ').filter((word: string) => word.length > 0)
      .length;
  }

  hasStructuredData(html: string): boolean {
    return (
      html.includes('application/ld+json') ||
      html.includes('itemscope') ||
      html.includes('microdata')
    );
  }

  async loadRobotsTxt(
    origin: string
  ): Promise<{ disallow: string[]; allow: string[] }> {
    if (this.robotsCache.has(origin)) {
      const cached = this.robotsCache.get(origin)!;
      return { disallow: cached.disallow || [], allow: cached.allow || [] };
    }

    try {
      const robotsUrl = `${origin}/robots.txt`;
      const response = await fetch(robotsUrl, {
        headers: { 'User-Agent': this.config.userAgent },
        // timeout: 5000 // node-fetch doesn't support timeout in this way
      } as any);

      if (response.ok) {
        const robotsTxt = await response.text();
        const rules = this.parseRobotsTxt(robotsTxt);
        this.robotsCache.set(origin, rules);
        return rules;
      }
    } catch (error) {
      this.logger.debug(`Could not load robots.txt for ${origin}`);
    }

    // Return empty rules if robots.txt not found
    const emptyRules = { disallow: [], allow: [] };
    this.robotsCache.set(origin, emptyRules);
    return emptyRules;
  }

  parseRobotsTxt(robotsTxt: string): { disallow: string[]; allow: string[] } {
    const rules = { disallow: [], allow: [] };
    const lines = robotsTxt.split('\n');
    let currentUserAgent = '';
    let isRelevantSection = false;

    for (const line of lines) {
      const trimmedLine = line.trim().toLowerCase();

      if (trimmedLine.startsWith('user-agent:')) {
        currentUserAgent = trimmedLine.split(':')[1].trim();
        isRelevantSection =
          currentUserAgent === '*' ||
          currentUserAgent === this.config.userAgent.toLowerCase();
      } else if (isRelevantSection) {
        if (trimmedLine.startsWith('disallow:')) {
          const path = trimmedLine.split(':').slice(1).join(':').trim();
          if (path) (rules.disallow as string[]).push(path);
        } else if (trimmedLine.startsWith('allow:')) {
          const path = trimmedLine.split(':').slice(1).join(':').trim();
          if (path) (rules.allow as string[]).push(path);
        }
      }
    }

    return rules;
  }

  canCrawl(url: string): boolean {
    const urlObj = new URL(url);
    const rules = this.robotsCache.get(urlObj.origin);

    if (!rules) return true;

    // Check disallow rules
    for (const disallow of rules.disallow) {
      if (urlObj.pathname.startsWith(disallow)) {
        return false;
      }
    }

    return true;
  }

  shouldCrawl(url: string, baseUrl: URL): boolean {
    try {
      const urlObj = new URL(url);

      // Same origin only
      if (urlObj.origin !== baseUrl.origin) {
        return false;
      }

      // Skip certain file types
      const skipExtensions = [
        '.pdf',
        '.doc',
        '.docx',
        '.xls',
        '.xlsx',
        '.ppt',
        '.pptx',
        '.zip',
        '.rar',
        '.exe',
      ];
      const pathname = urlObj.pathname.toLowerCase();

      if (skipExtensions.some((ext) => pathname.endsWith(ext))) {
        return false;
      }

      // Skip API endpoints
      if (pathname.startsWith('/api/')) {
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  getStats() {
    return {
      visitedPages: this.visited.size,
      discoveredUrls: this.discovered.size,
      errors: this.errors.length,
      robotsCacheSize: this.robotsCache.size,
    };
  }
}
