import { FlightData } from './IFlightData';
import { HelmetData } from './IHelmetData';
import { RenderMetadata, RenderDiagnostics } from './IRenderMetadata';

/**
 * 统一渲染结果接口
 */
export interface RenderResult {
  html: string;
  preloadLinks: string;
  helmet: HelmetData;
  statusCode: number;
  meta: RenderMetadata;
  diagnostics?: RenderDiagnostics;
  rscPayload?: FlightData;
}
