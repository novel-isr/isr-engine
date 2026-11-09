// Exercise the published programmatic entry and let natural process exit detect leaked resources.
process.env.NODE_ENV = 'production';
const { createISRApp, loadConfig } = await import('../../dist/novel-isr.js');
const { revalidatePath } = await import('../../dist/rsc/index.js');
const config = await loadConfig();
config.server.port = 0;
config.server.ops.health.enabled = false;
config.runtime.telemetry = {
  app: undefined,
  release: undefined,
  environment: 'staging',
  includeQueryString: false,
  events: false,
  errors: false,
  webVitals: false,
  exporters: [],
  integrations: {
    sentry: {
      enabled: true,
      dsn: undefined,
      tracesSampleRate: undefined,
      environment: 'staging',
      release: undefined,
    },
  },
};
delete process.env.SENTRY_DSN;
const app = await createISRApp(config);
const context = await app.start();
process.send({ ready: context.url });
process.on('message', async message => {
  try {
    if (message === 'shutdown') {
      await app.shutdown();
      process.disconnect();
    } else if (message === 'restart') {
      await app.shutdown();
      const restarted = await app.start();
      process.send({ ready: restarted.url });
    } else if (message === 'invalidate-ssg') {
      await revalidatePath('/regenerated');
      process.send({ invalidated: true });
    } else if (message === 'invalidate') {
      await revalidatePath('/cached');
      process.send({ invalidated: true });
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  }
});
