/**
 * pm2 process definitions for the VPS.
 *
 * Two processes, deliberately separate. The API serves requests and must stay responsive;
 * the worker drains the outbox, sends mail and runs scheduled jobs, and a slow send should
 * never hold up a request. Running them together would also mean restarting the API every
 * time a background job needed a fix.
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 save && pm2 startup
 */
module.exports = {
  apps: [
    {
      name: 'infinity-api',
      cwd: '/www/wwwroot/infinity/apps/api',
      script: 'dist/src/index.js',
      node_args: '--enable-source-maps',
      // Node's own clustering rather than several pm2 forks: the API is stateless, and
      // this keeps one port binding while using the cores the VPS actually has.
      instances: 2,
      exec_mode: 'cluster',
      max_memory_restart: '500M',
      env: { NODE_ENV: 'production' },
      error_file: '/www/wwwlogs/infinity-api.error.log',
      out_file: '/www/wwwlogs/infinity-api.log',
      merge_logs: true,
      time: true,
    },
    {
      name: 'infinity-worker',
      cwd: '/www/wwwroot/infinity/apps/api',
      script: 'dist/src/workers/index.js',
      node_args: '--enable-source-maps',
      /**
       * Exactly one. The scheduler takes a database lock so a second instance would be
       * harmless, but two workers doubles the polling for no gain, and duplicate
       * reminder emails are the kind of bug nobody notices until a customer does.
       */
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '400M',
      env: { NODE_ENV: 'production' },
      error_file: '/www/wwwlogs/infinity-worker.error.log',
      out_file: '/www/wwwlogs/infinity-worker.log',
      merge_logs: true,
      time: true,
    },
  ],
};
