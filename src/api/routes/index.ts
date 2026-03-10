import { Router } from 'express';
import type { AppContext } from '../../app-context.js';
import { createJobRoutes } from './job.routes.js';

export function createApiRouter(context: AppContext): Router {
  const router = Router();
  router.use('/', createJobRoutes(context));
  return router;
}
