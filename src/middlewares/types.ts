import { ISRContext } from '../types';

export type NextFunction = () => Promise<void>;

export type Middleware = (context: ISRContext, next: NextFunction) => Promise<void>;
