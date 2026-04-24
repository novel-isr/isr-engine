import { RenderMetadata } from './IRenderMetadata';

/**
 * Flight 协议基本值类型
 */
export type FlightValue = string | number | boolean | FlightValue[];

export interface FlightModuleReference {
  id: string;
  chunks: string[];
  name: string;
}

export interface FlightActionReference {
  id: string;
  bound: FlightValue[];
}

export interface FlightData {
  chunks: string[];
  moduleMap: Array<[string, FlightModuleReference]>;
  actionMap: Array<[string, FlightActionReference]>;
}

export interface SerializedFlightPayload extends FlightData {
  metadata: RenderMetadata;
}
