import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { text } from 'express';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Behind a reverse proxy / load balancer, every request arrives from the
  // proxy's address, so req.ip — which keys every per-IP rate limit (ADR-010,
  // ADR-011) — would be the same for all clients. TRUST_PROXY hands Express's
  // `trust proxy` setting the hops/addresses to trust X-Forwarded-For from:
  // a hop count ("1"), or addresses/presets ("loopback, uniquelocal").
  // Unset = trust nothing (direct exposure, local dev). Never set it when the
  // API is reachable directly, or clients can spoof their IP.
  const trustProxy = process.env.TRUST_PROXY?.trim();
  if (trustProxy) app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
  // Containers stop with SIGTERM: close the HTTP server and the pg pools
  // (OnModuleDestroy) cleanly instead of being killed after the timeout.
  app.enableShutdownHooks();

  // credentials: true so the httpOnly refresh cookie (architecture/api-contract.md
  // §0) round-trips from the frontend's own origin; tighten `origin` beyond
  // `true` once that origin is actually fixed (Step 1.4+).
  // Retry-After must be exposed explicitly, or a cross-origin frontend can't
  // read it from a 429 (found 2026-10-07 — the UI always said "a few minutes").
  app.enableCors({ origin: true, credentials: true, exposedHeaders: ['Retry-After'] });
  app.use(cookieParser());

  // Step 2.5: Microsoft's Autodiscover (Outlook) POSTs an XML request body
  // (Content-Type: text/xml or application/xml), not JSON — Nest's default
  // body parser only understands application/json, so req.body would
  // otherwise be `{}` on that one route. Scoped to XML content types only;
  // every other route (application/json) is unaffected.
  app.use(text({ type: ['text/xml', 'application/xml'], limit: '100kb' }));

  // architecture/api-contract.md §0: "Base path: /api/v1". The two
  // autodiscovery responders (Step 2.5, AutodiscoveryController) are the
  // one deliberate exception — api-contract.md §7 places them "outside the
  // /api/v1 namespace this contract governs", at their "protocol-mandated
  // well-known paths": a mail client hits these paths verbatim and has no
  // way to be told about a prefix.
  app.setGlobalPrefix('api/v1', {
    exclude: [
      { path: '.well-known/autoconfig/mail/config-v1.1.xml', method: RequestMethod.GET },
      { path: 'autodiscover/autodiscover.xml', method: RequestMethod.POST },
    ],
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // Registered after the ValidationPipe is configured, not before — it
  // normalizes whatever that pipe (or anything else) throws into the
  // contract's one error envelope. See common/filters/all-exceptions.filter.ts.
  app.useGlobalFilters(new AllExceptionsFilter());

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Business Workspace Platform API listening on port ${port}`);
}
bootstrap();
