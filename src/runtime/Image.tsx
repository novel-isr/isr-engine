/**
 * <Image> —— next/image 对标的图片组件，自动处理 LCP / CLS / 多分辨率。
 *
 * 用法：
 *   import { Image } from '@novel-isr/engine/image';
 *
 *   // 内部资产（走 /_/img sharp 优化端点）
 *   <Image src="/covers/book-1.jpg" width={800} height={600} alt="..." />
 *
 *   // 外部 URL（picsum / CDN / S3 等）—— 自动 passthrough，不走 /_/img
 *   <Image src="https://picsum.photos/300/400" width={300} height={400} alt="..." />
 *
 *   // LCP 候选（above-fold 首屏关键图）
 *   <Image src="..." width={300} height={400} alt="..." priority />
 *
 * 自动行为：
 *   1. 内部 src 走 /_/img endpoint + srcset 多分辨率（1x / 2x）；
 *      外部 src 原样输出（src 是 http://* 或 https://*）。
 *   2. 默认 loading="lazy" + decoding="async"；priority=true 切 eager + fetchPriority=high。
 *   3. priority=true 时通过 React 19 metadata hoisting 自动注入
 *      <link rel="preload" as="image">，浏览器 HTML 解析期立即发起加载，
 *      砍掉 LCP 的 "resource load delay" 区间。
 *   4. 强制 width/height 防 CLS（next/image 经验：忘了写就 layout shift）。
 */
import * as React from 'react';

export interface ImageProps {
  src: string;
  alt: string;
  width: number;
  height?: number;
  /** 端点路径，需与 createImagePlugin({ path }) 一致；默认 '/_/img'。仅对内部 src 生效 */
  endpoint?: string;
  /** 质量 1-100；仅对内部 src 生效（外部 URL 无优化能力） */
  quality?: number;
  /** 强制格式；仅对内部 src 生效 */
  format?: 'avif' | 'webp' | 'jpeg' | 'png';
  /** LCP 候选图设为 true：禁 lazy + fetchPriority=high + 自动 <link rel="preload"> */
  priority?: boolean;
  /** 设备像素密度数组，默认 [1, 2]（覆盖 retina）；仅对内部 src 生效 */
  densities?: number[];
  className?: string;
  style?: React.CSSProperties;
  sizes?: string;
}

/** 判断 src 是不是绝对 URL（http(s):// 开头）。
 *  外部资源不走 /_/img sharp 优化端点（远端 URL 没法直接 pipe sharp），
 *  passthrough 由浏览器直接拉源站。 */
function isExternalUrl(src: string): boolean {
  return /^https?:\/\//i.test(src);
}

/** SVG 是矢量，不需要 sharp 优化也不需要 1x/2x srcset（无限分辨率），
 *  无论 src 是内部还是外部，一律 passthrough 让浏览器直接加载。 */
function isSvg(src: string): boolean {
  // 去 query string 后判扩展名
  return /\.svg($|\?|#)/i.test(src);
}

export function Image(props: ImageProps): React.ReactElement {
  const passthrough = isExternalUrl(props.src) || isSvg(props.src);
  const endpoint = props.endpoint ?? '/_/img';
  const densities = props.densities ?? [1, 2];

  let src: string;
  let srcSet: string | undefined;

  if (passthrough) {
    // passthrough：外部 URL 或 SVG，不走 sharp 端点也不发 srcset，仍享有
    // priority / preload / width/height（CLS 防护）等所有 priority 行为
    src = props.src;
    srcSet = undefined;
  } else {
    const buildUrl = (w: number) => {
      const u = new URLSearchParams({ src: props.src, w: String(w) });
      if (props.quality) u.set('q', String(props.quality));
      if (props.format) u.set('fmt', props.format);
      return `${endpoint}?${u.toString()}`;
    };
    srcSet = densities.map(d => `${buildUrl(props.width * d)} ${d}x`).join(', ');
    src = buildUrl(props.width);
  }

  return (
    <>
      {/* React 19 metadata hoisting：<link> 会被自动提到 <head>。HTML 解析早期
          就发起 image preload，比等 React 渲染到 <img> 节点早几百 ms，直接砍
          掉 Lighthouse "Resource load delay" 那段。 */}
      {props.priority && (
        <link
          rel='preload'
          as='image'
          href={src}
          fetchPriority='high'
          {...(srcSet ? { imageSrcSet: srcSet } : {})}
          {...(props.sizes ? { imageSizes: props.sizes } : {})}
        />
      )}
      <img
        src={src}
        srcSet={srcSet}
        width={props.width}
        height={props.height}
        alt={props.alt}
        className={props.className}
        style={props.style}
        sizes={props.sizes}
        loading={props.priority ? 'eager' : 'lazy'}
        decoding={props.priority ? 'sync' : 'async'}
        fetchPriority={props.priority ? 'high' : 'auto'}
      />
    </>
  );
}
