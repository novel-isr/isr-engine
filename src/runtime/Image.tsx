/**
 * <Image> —— 配套 createImagePlugin 的 React 组件（next/image 极简对标）
 *
 * 用户态：
 *   import { Image } from '@novel-isr/engine/image';
 *   <Image src="/photo.jpg" width={800} height={600} alt="..." />
 *
 * 自动：
 *   - srcset 多分辨率（1x / 2x），浏览器选最合适的
 *   - 默认 loading="lazy" + decoding="async"（除非 priority=true → eager + fetchPriority="high"）
 *   - 强制 width/height 防 CLS（next/image 经验：忘了写就 layout shift）
 *   - 透传到 /_/img endpoint，支持 q/fmt
 */
import * as React from 'react';

export interface ImageProps {
  src: string;
  alt: string;
  width: number;
  height?: number;
  /** 端点路径，需与 createImagePlugin({ path }) 一致；默认 '/_/img' */
  endpoint?: string;
  /** 质量 1-100，默认走 endpoint 的 defaultQuality */
  quality?: number;
  /** 强制格式；默认 endpoint 按 Accept 自动选 avif/webp */
  format?: 'avif' | 'webp' | 'jpeg' | 'png';
  /** LCP 候选图设为 true：禁 lazy + 高优先级 */
  priority?: boolean;
  /** 设备像素密度数组，默认 [1, 2]（覆盖 retina）*/
  densities?: number[];
  className?: string;
  style?: React.CSSProperties;
  sizes?: string;
}

export function Image(props: ImageProps): React.ReactElement {
  const endpoint = props.endpoint ?? '/_/img';
  const densities = props.densities ?? [1, 2];

  const buildUrl = (w: number) => {
    const u = new URLSearchParams({ src: props.src, w: String(w) });
    if (props.quality) u.set('q', String(props.quality));
    if (props.format) u.set('fmt', props.format);
    return `${endpoint}?${u.toString()}`;
  };

  const srcSet = densities.map(d => `${buildUrl(props.width * d)} ${d}x`).join(', ');
  const src = buildUrl(props.width);

  return (
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
  );
}
