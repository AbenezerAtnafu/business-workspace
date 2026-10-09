import { Badge } from '@/components/ui/badge';
import type { Mailbox } from '@/lib/api/types';

export function MailboxStatusBadge({ status }: { status: Mailbox['status'] }) {
  if (status === 'suspended') return <Badge variant="warning">Suspended</Badge>;
  if (status === 'deleted') return <Badge variant="destructive">Deleted</Badge>;
  return <Badge variant="success">Active</Badge>;
}

/** Personal (has a userId) vs shared (userId null) — screen-flow-inventory.md §2.6. */
export function MailboxKindBadge({ mailbox }: { mailbox: Pick<Mailbox, 'userId'> }) {
  return mailbox.userId ? <Badge variant="outline">Personal</Badge> : <Badge variant="secondary">Shared</Badge>;
}
