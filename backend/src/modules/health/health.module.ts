import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/** GET /api/v1/health — see HealthController. DatabaseService is global. */
@Module({ controllers: [HealthController] })
export class HealthModule {}
