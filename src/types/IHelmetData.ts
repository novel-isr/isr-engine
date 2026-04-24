export interface HelmetData {
  title: { toString: () => string };
  meta: { toString: () => string };
  link: { toString: () => string };
  script: { toString: () => string };
  style: { toString: () => string };
  htmlAttributes: { toString: () => string };
  bodyAttributes: { toString: () => string };
}
