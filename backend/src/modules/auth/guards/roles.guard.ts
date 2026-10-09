import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppException } from '../../../common/errors/app-exception';
import { AccessTokenClaims } from '../../../common/tokens/tokens.service';
import { ROLES_KEY } from '../decorators/roles.decorator';

/**
 * architecture/api-contract.md §0: "a request that's authenticated but
 * insufficiently privileged for the action ... returns 403 FORBIDDEN_ROLE,
 * distinct from 401." Registered as a second global APP_GUARD in
 * AuthModule, declared AFTER JwtAuthGuard in that module's providers array —
 * NestJS runs global guards in registration order, so JwtAuthGuard always
 * attaches request.user (or rejects with 401) before this guard ever reads
 * it. A handler with no @Roles() metadata is unrestricted (every "Any" row
 * in the api-contract.md role column) and this guard is a pure no-op for
 * it, including every @Public() handler, none of which carry @Roles().
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<AccessTokenClaims['role'][] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request & { user?: AccessTokenClaims }>();
    const role = request.user?.role;

    if (!role || !requiredRoles.includes(role)) {
      throw new AppException(
        403,
        'FORBIDDEN_ROLE',
        `This action requires one of the following roles: ${requiredRoles.join(', ')}.`,
      );
    }

    return true;
  }
}
