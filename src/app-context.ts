import type { AppEnvironment } from './config/env.js';
import type { Logger } from './config/logger.js';
import type { CaptureService } from './modules/capture/capture.service.js';
import type { JobManager } from './modules/jobs/job-manager.js';
import type { ReplayService } from './modules/replay/replay.service.js';
import type { SweepService } from './modules/sweep/sweep.service.js';

export interface AppContext {
  env: AppEnvironment;
  logger: Logger;
  jobManager: JobManager;
  captureService: CaptureService;
  replayService: ReplayService;
  sweepService: SweepService;
}
