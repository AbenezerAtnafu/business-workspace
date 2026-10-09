'use client';

import { CheckCircle2, CircleDashed, CircleAlert, Clock } from 'lucide-react';
import { CopyButton } from '@/components/common/copy-button';
import { Badge } from '@/components/ui/badge';
import type { DnsRecord } from '@/lib/api/types';
import { cn } from '@/lib/utils';

const PURPOSE: Record<DnsRecord['purpose'], { title: string; why: string }> = {
  ownership: { title: 'Ownership', why: 'Proves you control this domain. Needed before anything else works.' },
  inbound: { title: 'Incoming mail (MX)', why: 'Delivers email sent to this domain to your mailboxes.' },
  spf: { title: 'SPF', why: 'Tells other servers we’re allowed to send mail for this domain.' },
  dkim: { title: 'DKIM', why: 'Signs outgoing mail so it isn’t marked as spam.' },
  dmarc: { title: 'DMARC', why: 'Recommended. Tells receivers what to do with mail that fails the checks above.' },
  autodiscovery: { title: 'Mail app setup (SRV)', why: 'Optional. Lets Outlook and Thunderbird configure themselves.' },
};

function StatusChip({ status }: { status: DnsRecord['status'] }) {
  if (status === 'matched')
    return (
      <Badge variant="success" className="gap-1">
        <CheckCircle2 className="h-3 w-3" /> Found
      </Badge>
    );
  if (status === 'pending-generation')
    return (
      <Badge variant="outline" className="gap-1">
        <Clock className="h-3 w-3" /> After ownership is verified
      </Badge>
    );
  return (
    <Badge variant="secondary" className="gap-1">
      <CircleDashed className="h-3 w-3" /> Not found yet
    </Badge>
  );
}

/**
 * The DNS checklist (GET /domains/{id}/dns-records), one card per record with
 * the exact host and value to paste at the DNS provider and a live status
 * chip per record, exactly as the endpoint reports it (§2.2).
 */
export function DnsRecords({ records }: { records: DnsRecord[] }) {
  return (
    <ol className="space-y-3">
      {records.map((r) => {
        const meta = PURPOSE[r.purpose];
        return (
          <li
            key={r.purpose}
            className={cn('rounded-lg border p-4', r.status === 'matched' && 'border-success/40 bg-success/5')}
            data-purpose={r.purpose}
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="space-y-0.5">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {meta.title}
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {r.type}
                  </Badge>
                  {!r.required && <span className="text-xs font-normal text-muted-foreground">Optional</span>}
                </p>
                <p className="text-sm text-muted-foreground">{meta.why}</p>
              </div>
              <StatusChip status={r.status} />
            </div>

            {r.entries.length === 0 ? (
              <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
                <CircleAlert className="h-4 w-4" />
                We’ll generate this record’s value as soon as the domain is verified.
              </p>
            ) : (
              <div className="mt-3 space-y-2">
                {r.entries.map((e) => (
                  <dl
                    key={`${e.host}-${e.value}`}
                    className="grid gap-2 rounded-md bg-muted/60 p-3 text-sm sm:grid-cols-[7rem_1fr]"
                  >
                    <dt className="text-xs text-muted-foreground sm:pt-1.5">Host / Name</dt>
                    <dd className="flex min-w-0 items-center gap-1">
                      <code className="min-w-0 break-all font-mono text-xs">{e.host}</code>
                      <CopyButton value={e.host} label={`Copy ${meta.title} host`} />
                      {e.host !== '@' && (
                        <span className="hidden truncate text-xs text-muted-foreground md:inline" title={e.fqdn}>
                          ({e.fqdn})
                        </span>
                      )}
                    </dd>
                    {e.priority !== undefined && (
                      <>
                        <dt className="text-xs text-muted-foreground sm:pt-1.5">Priority</dt>
                        <dd className="font-mono text-xs sm:pt-1.5">{e.priority}</dd>
                      </>
                    )}
                    <dt className="text-xs text-muted-foreground sm:pt-1.5">Value</dt>
                    <dd className="flex min-w-0 items-start gap-1">
                      <code className="min-w-0 break-all font-mono text-xs sm:pt-1.5">{e.value}</code>
                      <CopyButton value={e.value} label={`Copy ${meta.title} value`} />
                    </dd>
                  </dl>
                ))}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
