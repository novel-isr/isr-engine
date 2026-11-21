import express, { type Express, type ErrorRequestHandler, type RequestHandler } from 'express';
import { revalidateContent } from '../rsc/revalidate';
import { logger } from '../logger';
import {
  CONTENT_REVALIDATION_PATH,
  createOpsAuthMiddleware,
  getOpsRequestLimiter,
  type ResolvedOpsConfig,
} from './opsConfig';

const parsePublication = express.json({ limit: '64kb', inflate: false });

const requireJson: RequestHandler = (req, res, next) => {
  if (!req.is('application/json')) {
    res.status(415).json({ error: 'Expected application/json' });
    return;
  }
  parsePublication(req, res, next);
};

const rejectInvalidJson: ErrorRequestHandler = (error, _req, res, _next) => {
  const status = error.status === 413 || error.status === 415 ? error.status : 400;
  res.status(status).json({ error: 'Invalid content publication JSON' });
};

const applyPublication: RequestHandler = async (req, res) => {
  try {
    await revalidateContent(req.body);
    res.status(204).end();
  } catch (error) {
    if (error instanceof TypeError) {
      res.status(400).json({ error: error.message });
      return;
    }
    logger.error('[Ops] Content revalidation failed', error);
    res.status(503).json({ error: 'Content revalidation unavailable' });
  }
};

export function mountContentRevalidationRoute(app: Express, ops: ResolvedOpsConfig): void {
  const requirePost: RequestHandler = (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!ops.contentRevalidation.enabled) {
      res.status(404).end();
      return;
    }
    if (req.method !== 'POST') {
      res.set('Allow', 'POST').status(405).end();
      return;
    }
    next();
  };
  app.all(
    CONTENT_REVALIDATION_PATH,
    requirePost,
    getOpsRequestLimiter(ops),
    createOpsAuthMiddleware('contentRevalidation', ops),
    requireJson,
    rejectInvalidJson,
    applyPublication
  );
}
