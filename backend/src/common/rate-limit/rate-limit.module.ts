import { Module } from '@nestjs/common';
import { RateLimitService } from './rate-limit.service';

/** Failure-based rate limiting for credential checks (migration 012). */
@Module({
  providers: [RateLimitService],
  exports: [RateLimitService],
})
export class RateLimitModule {}
