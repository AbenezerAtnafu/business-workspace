import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppException } from '../../../common/errors/app-exception';
import { AccessTokenClaims, TokensService } from '../../../common/tokens/tokens.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Registered as the global APP_GUARD (see auth.module.ts) — every route is
 * authenticated by default, per architecture/api-contract.md §0
 * ("Authentication: Bearer access token ... 15-minute lifetime"). Routes opt
 * out individually with @Public() (POST /organizations, and from later
 * sub-slices: POST /auth/login, GET /invites/{token}, etc.) rather than
 * opting in module-by-module, so a new endpoint is locked down unless
 * someone deliberately marks it otherwise.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokensService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request & { user: AccessTokenClaims }>();
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;

    if (!token) {
      throw new AppException(401, 'UNAUTHENTICATED', 'Missing or malformed Authorization header.');
    }

    // Throws AppException(401, 'UNAUTHENTICATED', ...) on any invalid/
    // expired/wrong-type token — propagates straight to AllExceptionsFilter.
    request.user = this.tokens.verifyAccessToken(token);
    return true;
  }
}
