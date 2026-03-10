import { createApp, createAppContext } from './app.js';

const context = createAppContext();
const app = createApp(context);

const server = app.listen(context.env.port, () => {
  context.logger.info('Express server started', {
    port: context.env.port,
    nodeEnv: context.env.nodeEnv,
  });
});

function shutdown(signal: string): void {
  context.logger.info('Shutdown signal received', { signal });

  server.close((error?: Error) => {
    if (error) {
      context.logger.error('Server shutdown failed', { signal, error });
      process.exitCode = 1;
      return;
    }

    context.logger.info('Server shutdown completed', { signal });
    process.exitCode = 0;
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
