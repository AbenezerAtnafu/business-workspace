import { Badge } from '@/components/ui/badge';
import type { Domain } from '@/lib/api/types';

export function VerificationBadge({ status }: { status: Domain['verificationStatus'] }) {
  if (status === 'verified') return <Badge variant="success">Verified</Badge>;
  if (status === 'failed') return <Badge variant="warning">Not verified yet</Badge>;
  return <Badge variant="secondary">Pending</Badge>;
}

export function DkimBadge({ status }: { status: Domain['dkimStatus'] }) {
  if (status === 'verified') return <Badge variant="success">DKIM published</Badge>;
  if (status === 'pending') return <Badge variant="warning">DKIM not published</Badge>;
  return <Badge variant="outline">DKIM after verification</Badge>;
}
