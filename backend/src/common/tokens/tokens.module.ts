import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TokensService } from './tokens.service';

/**
 * Shared JWT access-token signing, used by Organizations (Step 1.3's Owner
 * bootstrap, which must issue a session immediately on signup) and, from
 * Step 1.4 onward, Auth's own /auth/login, /auth/refresh, etc. One place to
 * hold the signing config (architecture/api-contract.md §0: 15-minute
 * access token) rather than duplicating JwtModule.registerAsync in every
 * module that needs to mint one.
 */
@Module({
  imports: [
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.accessSecret'),
        signOptions: { expiresIn: config.get<string>('jwt.accessTtl') },
      }),
    }),
  ],
  providers: [TokensService],
  exports: [TokensService],
})
export class TokensModule {}
