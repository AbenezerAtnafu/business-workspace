import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';

// Global so every feature module can inject DatabaseService without each
// one re-importing this module — see planning/implementation-plan.md Step 1.2.
@Global()
@Module({
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
