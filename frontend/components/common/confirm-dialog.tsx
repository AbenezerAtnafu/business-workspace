'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { FormError } from './form-error';
import { Spinner } from './spinner';
import { errorMessage } from '@/lib/api/errors';

/**
 * Confirmation step for consequential actions. `acknowledge` adds a
 * checkbox the user must tick first — used where a single click is
 * explicitly not enough (Transfer Ownership, screen-flow-inventory.md §2.3).
 * `onConfirm` errors are shown inside the dialog; the dialog stays open.
 * Return a string from `describeError` to replace the default message for
 * specific error codes.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive,
  acknowledge,
  onConfirm,
  describeError,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  acknowledge?: string;
  onConfirm: () => Promise<void>;
  describeError?: (err: unknown) => React.ReactNode | undefined;
  children?: React.ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<React.ReactNode | null>(null);

  const change = (next: boolean) => {
    if (busy) return;
    if (!next) {
      setAck(false);
      setError(null);
    }
    onOpenChange(next);
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      setAck(false);
      onOpenChange(false);
    } catch (err) {
      setError(describeError?.(err) ?? errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription asChild><div>{description}</div></DialogDescription>}
        </DialogHeader>
        {children}
        {typeof error === 'string' ? <FormError message={error} /> : error}
        {acknowledge && (
          <div className="flex items-start gap-2">
            <Checkbox id="confirm-ack" checked={ack} onCheckedChange={(v) => setAck(v === true)} />
            <Label htmlFor="confirm-ack" className="text-sm font-normal leading-snug">
              {acknowledge}
            </Label>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => change(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            onClick={confirm}
            disabled={busy || (!!acknowledge && !ack)}
          >
            {busy && <Spinner />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
