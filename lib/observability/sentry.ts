import * as Sentry from '@sentry/nextjs';
import { scrub } from './scrub';

/** No-op unless SENTRY_DSN is set. PII is never sent: defaults off + deep scrub before send. */
export function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({
    dsn,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    beforeSend(event) {
      if (event.request) {
        delete event.request.cookies;
        delete event.request.headers;
        delete event.request.data;
      }
      delete event.user;
      return scrub(event);
    },
    beforeBreadcrumb(b) {
      return scrub(b);
    },
  });
}
