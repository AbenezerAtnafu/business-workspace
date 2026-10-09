import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AccessTokenClaims } from '../../../common/tokens/tokens.service';
import type { Request } from 'express';

/**
 * Pulls the access-token claims JwtAuthGuard attached to the request
 * (request.user) into a controller parameter, typed as AccessTokenClaims
 * rather than `any`. Only valid on routes the guard actually ran for —
 * never used on a @Public() handler.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AccessTokenClaims => {
    const request = ctx.switchToHttp().getRequest<Request & { user: AccessTokenClaims }>();
    return request.user;
  },
);
