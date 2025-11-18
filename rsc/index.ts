/**
 * RSC Module - 真正的 React Server Components Flight 协议实现
 */

// ========== Flight 协议核心 ==========
export {
  FlightSerializer,
  FlightDeserializer,
  FlightProtocolHandler,
  flightProtocol,
} from './PlumberProtocol';

export type {
  FlightChunkType,
  ModuleReference,
  ServerActionReference,
  FlightChunk,
  FlightStream,
} from './PlumberProtocol';

// ========== 兼容性导出 (旧 API) ==========
export {
  PlumberSerializer,
  PlumberDeserializer,
  PlumberProtocolHandler,
  plumberProtocol,
} from './PlumberProtocol';

// ========== RSC Runtime ==========
export { RSCRuntime, rscRuntime } from './RSCRuntime';
export type { RSCComponentMeta, RSCRuntimeConfig } from './RSCRuntime';
