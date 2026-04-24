import { ISRContext } from '../types';
import { Middleware, NextFunction } from './types';
import { Logger } from '../logger/Logger';

export class MiddlewareComposer {
  private static instance: MiddlewareComposer;
  private middlewares: Middleware[] = [];
  private logger = Logger.getInstance();

  public static getInstance(): MiddlewareComposer {
    if (!MiddlewareComposer.instance) {
      MiddlewareComposer.instance = new MiddlewareComposer();
    }
    return MiddlewareComposer.instance;
  }

  /**
   * 注册中间件
   * 支持传入单个、多个或数组形式的中间件
   */
  use(...middlewares: (Middleware | Middleware[])[]) {
    this.middlewares.push(...middlewares.flat());
  }

  /**
   * 执行中间件链 (洋葱模型) - 高性能优化版
   * @param context ISR 上下文
   * @param finalHandler 最终执行的业务逻辑 (通常是渲染)
   */
  async compose(context: ISRContext, finalHandler: NextFunction) {
    const middlewares = this.middlewares;
    const length = middlewares.length;

    // 优化：如果没有中间件，直接执行 finalHandler
    if (length === 0) {
      return finalHandler();
    }

    let index = -1;

    const dispatch = async (i: number): Promise<void> => {
      if (i <= index) {
        throw new Error('next() called multiple times');
      }
      index = i;

      // 优化：减少闭包创建，直接获取函数引用
      if (i === length) {
        return finalHandler();
      }

      const fn = middlewares[i];

      try {
        // 优化：使用 Promise.resolve 确保返回值是 Promise，避免非 async 函数导致的错误
        return Promise.resolve(fn(context, dispatch.bind(null, i + 1)));
      } catch (err) {
        this.logger.error(`Middleware error at index ${i}:`, err);
        throw err;
      }
    };

    return dispatch(0);
  }
}
