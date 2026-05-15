/**
 * 静态 500 兜底 HTML 模板 —— engine 入口 catch-all 在最坏情况下的最后一道墙。
 *
 * 触发条件：rscHandler 抛错且 SSR / csr-shell 兜底也失败 —— 此时 React 树根本没机会
 * 渲染 GlobalErrorBoundary，必须在 Express 层用纯字符串模板返回一个最小可读页面。
 *
 * 设计：
 *   - 零依赖、纯字符串拼接：再差的环境也能渲染（主进程 OOM 后兜底也不会再失败）
 *   - 含 traceId：让用户能贴给 support 一查到底；engine 已生成（traceId 必有值）
 *   - 不含任何业务文案：不假设业务品牌，业务侧想覆盖直接 monkey-patch 这个函数
 *     或在 reverse proxy / nginx 层用 error_page 替换
 *   - 转义 traceId 防 XSS：理论上 traceId 由 engine 生成应安全，但纵深防御
 */

/** HTML escape —— 把 traceId 中的 5 个特殊字符替换成 entity */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 渲染 500 兜底页面。
 *
 * @param traceId 用户向 support 反馈时引用的请求标识；engine 入口生成保证非空。
 *                空串 / undefined 显示 'unknown'。
 */
export function renderError500Html(traceId: string | undefined): string {
  const safeTrace = escapeHtml(traceId && traceId.length > 0 ? traceId : 'unknown');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>500 · 服务暂时不可用</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background:#fafafa;color:#111;display:flex;align-items:center;justify-content:center;padding:24px;line-height:1.5}
  main{max-width:480px;width:100%;background:#fff;border-radius:12px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,.05),0 1px 2px rgba(0,0,0,.03)}
  h1{font-size:20px;font-weight:600;margin-bottom:8px}
  p{font-size:14px;color:#555;margin-bottom:16px}
  .trace{font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;font-size:12px;background:#f4f4f5;color:#333;padding:8px 12px;border-radius:6px;word-break:break-all;user-select:all}
  .actions{margin-top:20px;display:flex;gap:8px}
  a,button{display:inline-block;font-size:14px;padding:8px 14px;border-radius:6px;border:1px solid #d4d4d8;background:#fff;color:#111;text-decoration:none;cursor:pointer;font-family:inherit}
  a:hover,button:hover{background:#f4f4f5}
</style>
</head>
<body>
<main>
  <h1>服务暂时不可用</h1>
  <p>页面渲染遇到异常。问题已经记录，稍后请重试。</p>
  <p>如果反馈给客服，请附上以下追踪 ID：</p>
  <div class="trace" aria-label="trace id">${safeTrace}</div>
  <div class="actions">
    <a href="/">返回首页</a>
    <button type="button" onclick="location.reload()">重试</button>
  </div>
</main>
</body>
</html>`;
}
