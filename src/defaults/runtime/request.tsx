/**
 * RSC 请求约定 —— 区分 RSC / SSR / Server Action 三类请求
 *
 * 约定：
 *   - URL 后缀 `_.rsc` 标识 "仅返回 Flight 流" 的 RSC 请求
 *   - 请求头 `x-rsc-action` 携带 Server Action ID
 *   - POST + x-rsc-action 代表调用 Server Action（响应为新 Flight 流）
 */
const URL_POSTFIX = '_.rsc';
const HEADER_ACTION_ID = 'x-rsc-action';

export type RenderRequest = {
  /** 为 true 时响应纯 Flight 流（text/x-component） */
  isRsc: boolean;
  /** 为 true 时表示 POST 请求（Server Action 调用） */
  isAction: boolean;
  /** Server Action ID（仅 isAction 为 true 时有意义） */
  actionId?: string;
  /** 已去除 `_.rsc` 后缀的规范化请求 */
  request: Request;
  /** 已去除 `_.rsc` 后缀的规范化 URL */
  url: URL;
};

/**
 * 客户端构造 RSC 请求（用于导航 / Server Action 调用）
 */
export function createRscRenderRequest(
  urlString: string,
  action?: { id: string; body: BodyInit }
): Request {
  const url = new URL(urlString);
  url.pathname += URL_POSTFIX;
  const headers = new Headers();
  if (action) {
    headers.set(HEADER_ACTION_ID, action.id);
  }
  return new Request(url.toString(), {
    method: action ? 'POST' : 'GET',
    headers,
    body: action?.body,
  });
}

/**
 * 服务端解析入站请求，输出 RenderRequest 描述
 */
export function parseRenderRequest(request: Request): RenderRequest {
  const url = new URL(request.url);
  const isAction = request.method === 'POST';

  if (url.pathname.endsWith(URL_POSTFIX)) {
    url.pathname = url.pathname.slice(0, -URL_POSTFIX.length);
    const actionId = request.headers.get(HEADER_ACTION_ID) || undefined;
    if (isAction && !actionId) {
      throw new Error('Missing x-rsc-action header for RSC action request');
    }
    return {
      isRsc: true,
      isAction,
      actionId,
      request: new Request(url, request),
      url,
    };
  }

  return {
    isRsc: false,
    isAction,
    request,
    url,
  };
}
