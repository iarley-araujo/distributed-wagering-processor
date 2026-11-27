import type { NextFunction, Request, Response } from 'express';
import { uuidv7 } from '../shared/domain/ids';
import { logContext } from './log-context';
import type { Metrics } from './metrics';

const CORRELATION_HEADER = 'x-correlation-id';
const VALID_CORRELATION_ID = /^[\x21-\x7E]{1,128}$/;

/** Correlation id por requisição (vem do cliente ou é gerado) + métrica de latência. */
export function httpContextMiddleware(metrics: Metrics) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.header(CORRELATION_HEADER);
    const correlationId = incoming && VALID_CORRELATION_ID.test(incoming) ? incoming : uuidv7();
    res.setHeader('X-Correlation-Id', correlationId);
    const started = performance.now();
    res.on('finish', () => {
      const route = (req.route?.path as string | undefined) ?? 'unmatched';
      metrics.httpRequests.observe(
        { method: req.method, route: `${req.baseUrl}${route}`, status: String(res.statusCode) },
        (performance.now() - started) / 1000,
      );
    });
    logContext.run({ correlationId }, () => next());
  };
}
