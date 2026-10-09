import { Controller, Get, HttpCode, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { DatabaseService } from '../../database/database.service';

/**
 * GET /api/v1/health — liveness + readiness for container healthchecks and
 * load balancers (ADR-012). Public, no tenant context, no data returned
 * beyond up/down: `SELECT 1` on the app_user pool proves the API can reach
 * Postgres with its runtime role. 503 when it can't, so an orchestrator
 * stops routing to this instance instead of serving 500s.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  @Public()
  @Get()
  @HttpCode(200)
  async check() {
    try {
      await Promise.race([
        this.db.query('SELECT 1'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
      ]);
    } catch {
      throw new ServiceUnavailableException({ status: 'error', database: 'unreachable' });
    }
    return { status: 'ok', database: 'ok' };
  }
}
