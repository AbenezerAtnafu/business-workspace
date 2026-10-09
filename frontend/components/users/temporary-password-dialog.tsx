'use client';

import { useEffect, useState } from 'react';
import { Check, Copy, KeyRound, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
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

export interface TemporaryCredentials {
  email: string;
  temporaryPassword: string;
  /** "created" for Path B, "reissued" for a password reissue (same UI either way — Flow 5). */
  reason: 'created' | 'reissued';
}

/**
 * One-time display of an admin-issued temporary password
 * (screen-flow-inventory.md §2.3, Flows 4 & 5; api-contract.md §3: "render it
 * once in a modal with a copy button and an explicit 'this won't be shown
 * again' warning"). The password lives only in this component's props for
 * as long as the dialog is open — it's never written to storage, the URL or
 * a toast — and the dialog can't be dismissed by clicking outside or
 * pressing Escape: the admin has to confirm they've saved it.
 */
export function TemporaryPasswordDialog({
  credentials,
  onDone,
}: {
  credentials: TemporaryCredentials | null;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setCopied(false);
    setSaved(false);
  }, [credentials]);

  const copy = async () => {
    if (!credentials) return;
    try {
      await navigator.clipboard.writeText(credentials.temporaryPassword);
      setCopied(true);
    } catch {
      toast.error('Couldn’t copy automatically. Select the password and copy it manually.');
    }
  };

  return (
    <Dialog open={credentials !== null}>
      <DialogContent
        hideClose
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5" />
            {credentials?.reason === 'reissued' ? 'New temporary password' : 'Account created'}
          </DialogTitle>
          <DialogDescription>
            Give this to <strong className="break-all text-foreground">{credentials?.email}</strong> in person, by
            phone or by chat. They’ll be asked to choose their own password when they first sign in.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="temp-password">Temporary password</Label>
          <div className="flex gap-2">
            <input
              id="temp-password"
              readOnly
              value={credentials?.temporaryPassword ?? ''}
              onFocus={(e) => e.currentTarget.select()}
              className="flex h-10 w-full rounded-md border border-input bg-muted px-3 font-mono text-base tracking-wide"
              aria-describedby="temp-password-warning"
            />
            <Button type="button" variant="outline" onClick={copy} className="h-10 shrink-0">
              {copied ? <Check className="text-success" /> : <Copy />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>

        <Alert variant="warning" id="temp-password-warning">
          <TriangleAlert className="h-4 w-4" />
          <AlertDescription>
            This password won’t be shown again. If it’s lost, reissue a new one from the user’s page.
          </AlertDescription>
        </Alert>

        <div className="flex items-start gap-2">
          <Checkbox id="temp-saved" checked={saved} onCheckedChange={(v) => setSaved(v === true)} />
          <Label htmlFor="temp-saved" className="text-sm font-normal leading-snug">
            I’ve copied or written down this password
          </Label>
        </div>

        <DialogFooter>
          <Button onClick={onDone} disabled={!saved}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
