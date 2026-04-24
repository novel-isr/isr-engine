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
  srcSet: string;
  width: number;
  height?: number;
  loading: string;
  decoding: string;
  fetchPriority: string;
  alt: string;
}

function renderProps<P>(el: React.ReactElement): P {
  return el.props as P;
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
});
