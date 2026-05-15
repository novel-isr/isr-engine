/**
 * <Image> 组件单元测试
 *
 * 不引入 React DOM —— 直接断言 React.createElement 后的 props 形状
 * （vitest 默认 node 环境，避免引 jsdom 拖慢）
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { Image } from '../Image';

interface ImgProps {
  src: string;
  srcSet?: string;
  width: number;
  height?: number;
  loading: string;
  decoding: string;
  fetchPriority: string;
  alt: string;
}

interface LinkProps {
  rel: string;
  as: string;
  href: string;
  fetchPriority: string;
  imageSrcSet?: string;
  imageSizes?: string;
}

/** Image 返回 Fragment（可选 <link> + 必出 <img>），单测要从 children 里抽 img */
function renderProps<P>(el: React.ReactElement): P {
  const children = el.props.children;
  // priority=false 时 Fragment 第一个 child 是 false（{priority && ...}），第二个是 img
  // priority=true 时第一个是 <link>，第二个是 img
  const list = Array.isArray(children) ? children : [children];
  const img = list.find(c => React.isValidElement(c) && c.type === 'img');
  return (img as React.ReactElement).props as P;
}

function getPreloadLink(el: React.ReactElement): LinkProps | null {
  const children = el.props.children;
  const list = Array.isArray(children) ? children : [children];
  const link = list.find(c => React.isValidElement(c) && c.type === 'link');
  return link ? ((link as React.ReactElement).props as LinkProps) : null;
}

describe('<Image>', () => {
  it('生成 1x / 2x srcset 默认', () => {
    const el = Image({ src: '/photo.jpg', alt: 'p', width: 400 });
    const props = renderProps<ImgProps>(el);
    expect(props.src).toContain('/_/img');
    expect(props.src).toContain('src=%2Fphoto.jpg');
    expect(props.src).toContain('w=400');
    expect(props.srcSet).toContain('w=400');
    expect(props.srcSet).toContain('1x');
    expect(props.srcSet).toContain('w=800');
    expect(props.srcSet).toContain('2x');
  });

  it('priority=true → eager + high', () => {
    const el = Image({ src: '/x.jpg', alt: '', width: 100, priority: true });
    const props = renderProps<ImgProps>(el);
    expect(props.loading).toBe('eager');
    expect(props.decoding).toBe('sync');
    expect(props.fetchPriority).toBe('high');
  });

  it('默认 lazy + async', () => {
    const el = Image({ src: '/x.jpg', alt: '', width: 100 });
    const props = renderProps<ImgProps>(el);
    expect(props.loading).toBe('lazy');
    expect(props.decoding).toBe('async');
    expect(props.fetchPriority).toBe('auto');
  });

  it('quality 透传到 endpoint URL', () => {
    const el = Image({ src: '/x.jpg', alt: '', width: 100, quality: 60 });
    const props = renderProps<ImgProps>(el);
    expect(props.src).toContain('q=60');
  });

  it('format 透传到 endpoint URL', () => {
    const el = Image({ src: '/x.jpg', alt: '', width: 100, format: 'avif' });
    const props = renderProps<ImgProps>(el);
    expect(props.src).toContain('fmt=avif');
  });

  it('自定义 endpoint', () => {
    const el = Image({
      src: '/x.jpg',
      alt: '',
      width: 100,
      endpoint: '/custom-img',
    });
    const props = renderProps<ImgProps>(el);
    expect(props.src).toContain('/custom-img?');
  });

  it('densities 自定义', () => {
    const el = Image({
      src: '/x.jpg',
      alt: '',
      width: 200,
      densities: [1, 1.5, 3],
    });
    const props = renderProps<ImgProps>(el);
    expect(props.srcSet).toContain('w=200');
    expect(props.srcSet).toContain('w=300');
    expect(props.srcSet).toContain('w=600');
    expect(props.srcSet).toContain('1x');
    expect(props.srcSet).toContain('1.5x');
    expect(props.srcSet).toContain('3x');
  });

  it('width/height 防 CLS：透传到 <img>', () => {
    const el = Image({ src: '/x.jpg', alt: '', width: 800, height: 600 });
    const props = renderProps<ImgProps>(el);
    expect(props.width).toBe(800);
    expect(props.height).toBe(600);
  });

  it('外部 URL passthrough：不走 /_/img，原 src 直出', () => {
    const el = Image({
      src: 'https://picsum.photos/300/400',
      alt: '',
      width: 300,
    });
    const props = renderProps<ImgProps>(el);
    expect(props.src).toBe('https://picsum.photos/300/400');
    expect(props.srcSet).toBeUndefined();
  });

  it('priority=true 注入 <link rel="preload"> 到 Fragment（React 19 hoist 到 head）', () => {
    const el = Image({
      src: '/cover.jpg',
      alt: '',
      width: 300,
      priority: true,
    });
    const link = getPreloadLink(el);
    expect(link).not.toBeNull();
    expect(link!.rel).toBe('preload');
    expect(link!.as).toBe('image');
    expect(link!.fetchPriority).toBe('high');
    expect(link!.href).toContain('/_/img');
    expect(link!.imageSrcSet).toContain('1x');
    expect(link!.imageSrcSet).toContain('2x');
  });

  it('priority=false 不注入 preload link', () => {
    const el = Image({ src: '/x.jpg', alt: '', width: 100 });
    expect(getPreloadLink(el)).toBeNull();
  });
});
