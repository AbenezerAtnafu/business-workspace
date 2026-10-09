import { SetMetadata } from '@nestjs/common';
import { AccessTokenClaims } from '../../../common/tokens/tokens.service';

export const ROLES_KEY = 'roles';

/**
 * Marks a handler as restricted to one or more of the fixed `owner | admin |
 * member` roles (architecture/data-model.md's CHECK constraint — roles are
 * not customizable in MVP). Read by RolesGuard. A handler with no
 * @Roles() at all is reachable by any authenticated caller — the "Any" rows
 * in architecture/api-contract.md's per-endpoint role column (e.g. GET
 * /org-units, GET /groups) need no decorator at all; JwtAuthGuard alone
 * already covers "authenticated."
 *
 * First introduced in Step 1.5 (Org Units & Groups) — every endpoint built
 * before this one happened to be either @Public() or open to "Any"
 * authenticated role, so no role-gating primitive existed yet.
 */
export const Roles = (...roles: AccessTokenClaims['role'][]) => SetMetadata(ROLES_KEY, roles);
