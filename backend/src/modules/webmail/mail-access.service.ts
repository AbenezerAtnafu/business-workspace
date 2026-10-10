import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { AppException } from '../../common/errors/app-exception';
import { AccessTokenClaims } from '../../common/tokens/tokens.service';

export type MailAccessLevel = 'owner' | 'manage' | 'send_as' | 'read_only';

export interface MailboxAccess {
  mailboxId: string;
  organizationId: string;
  address: string;
  isShared: boolean;
  level: MailAccessLevel;
  /** Display name for From: the owner's name (personal) or none (shared). */
  displayName: string | null;
}

const RANK: Record<MailAccessLevel, number> = { read_only: 1, send_as: 2, manage: 3, owner: 4 };

/**
 * Who may do what with a mailbox's MAIL (api-contract.md §8) — deliberately
 * not the same as who may administer it (§7):
 *   - owner (the personal mailbox's user) and grantees, directly or through a
 *     group, may read; send_as/manage/owner may also send, draft, move, delete;
 *   - Owner/Admin ROLES do not get to read other people's mail just by being
 *     admins: they administer mailboxes, they need a grant to open one.
 * A suspended mailbox can't be used at all (Dovecot won't serve it either).
 */
@Injectable()
export class MailAccessService {
  constructor(private readonly db: DatabaseService) {}

  async resolve(claims: AccessTokenClaims, mailboxId: string, need: 'read' | 'write'): Promise<MailboxAccess> {
    const row = await this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, claims.organizationId);
      const { rows } = await client.query<{
        id: string;
        organization_id: string;
        address: string;
        user_id: string | null;
        status: string;
        owner_name: string | null;
        grant_level: string | null;
      }>(
        `SELECT m.id, m.organization_id, lower(m.local_part || '@' || d.domain_name) AS address,
                m.user_id, m.status, u.name AS owner_name,
                (SELECT g.access_level FROM tenant.mailbox_access g
                  WHERE g.mailbox_id = m.id
                    AND (g.user_id = $2 OR g.group_id IN (SELECT group_id FROM tenant.group_members WHERE user_id = $2))
                  ORDER BY CASE g.access_level WHEN 'manage' THEN 3 WHEN 'send_as' THEN 2 ELSE 1 END DESC
                  LIMIT 1) AS grant_level
         FROM tenant.mailboxes m
         JOIN control.domains d ON d.id = m.domain_id
         LEFT JOIN tenant.users u ON u.id = m.user_id
         WHERE m.id = $1 AND m.status <> 'deleted'`,
        [mailboxId, claims.userId],
      );
      return rows[0];
    });
    if (!row) throw new AppException(404, 'NOT_FOUND', 'Mailbox not found.');

    const level: MailAccessLevel | null =
      row.user_id === claims.userId ? 'owner' : ((row.grant_level as MailAccessLevel | null) ?? null);
    if (!level) {
      throw new AppException(403, 'FORBIDDEN_MAILBOX_ACCESS', 'You do not have access to this mailbox.');
    }
    if (need === 'write' && RANK[level] < RANK.send_as) {
      throw new AppException(403, 'FORBIDDEN_MAILBOX_ACCESS', 'Read-only access: you can read this mailbox but not send or change it.');
    }
    if (row.status !== 'active') {
      throw new AppException(409, 'MAILBOX_SUSPENDED', 'This mailbox is suspended.');
    }
    return {
      mailboxId: row.id,
      organizationId: row.organization_id,
      address: row.address,
      isShared: row.user_id === null,
      level,
      displayName: row.user_id ? row.owner_name : null,
    };
  }

  /** Mailboxes the caller can open in webmail (own + granted), with the access level each gives. */
  async listForUser(claims: AccessTokenClaims): Promise<
    { id: string; address: string; isShared: boolean; access: MailAccessLevel; status: string }[]
  > {
    return this.db.withTransaction(async (client) => {
      await this.db.setTenantContext(client, claims.organizationId);
      const { rows } = await client.query<{ id: string; address: string; is_shared: boolean; access: MailAccessLevel; status: string }>(
        `WITH grants AS (
           SELECT g.mailbox_id, max(CASE g.access_level WHEN 'manage' THEN 3 WHEN 'send_as' THEN 2 ELSE 1 END) AS rank
           FROM tenant.mailbox_access g
           WHERE g.user_id = $1 OR g.group_id IN (SELECT group_id FROM tenant.group_members WHERE user_id = $1)
           GROUP BY g.mailbox_id
         )
         SELECT m.id, lower(m.local_part || '@' || d.domain_name) AS address, (m.user_id IS NULL) AS is_shared, m.status,
                CASE WHEN m.user_id = $1 THEN 'owner'
                     WHEN gr.rank = 3 THEN 'manage' WHEN gr.rank = 2 THEN 'send_as' ELSE 'read_only' END AS access
         FROM tenant.mailboxes m
         JOIN control.domains d ON d.id = m.domain_id
         LEFT JOIN grants gr ON gr.mailbox_id = m.id
         WHERE m.status <> 'deleted' AND (m.user_id = $1 OR gr.mailbox_id IS NOT NULL)
         -- own first: a plain (user_id = $1) is NULL for shared mailboxes, and NULLs sort first under DESC
         ORDER BY (m.user_id IS NOT DISTINCT FROM $1) DESC, 2`,
        [claims.userId],
      );
      return rows.map((r) => ({ id: r.id, address: r.address, isShared: r.is_shared, access: r.access, status: r.status }));
    });
  }
}
