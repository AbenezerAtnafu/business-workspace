import { Crown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { Role, User } from '@/lib/api/types';
import { ROLE_LABEL } from '@/components/layout/nav-config';
import { userStatusBadge } from '@/lib/users';

export function RoleBadge({ role }: { role: Role }) {
  return (
    <Badge variant={role === 'member' ? 'outline' : 'secondary'} className="gap-1">
      {role === 'owner' && <Crown className="h-3 w-3" />}
      {ROLE_LABEL[role]}
    </Badge>
  );
}

export function StatusBadge({ user }: { user: Pick<User, 'status' | 'mustChangePassword' | 'lastLoginAt'> }) {
  const s = userStatusBadge(user);
  return (
    <Badge variant={s.tone} title={s.hint}>
      {s.label}
    </Badge>
  );
}
