/**
 * CSS Modules 类型声明 —— 让 engine 内部 tsc 通过
 * 用户项目侧由 `vite/client` types 提供同款声明，互不冲突
 */
declare module '*.module.scss' {
  const styles: Record<string, string>;
  export default styles;
}

declare module '*.module.css' {
  const styles: Record<string, string>;
  export default styles;
}
