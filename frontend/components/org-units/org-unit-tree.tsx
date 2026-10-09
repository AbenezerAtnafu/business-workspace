'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Building2,
  CornerDownRight,
  FolderTree,
  MoreHorizontal,
  MoveRight,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { Spinner } from '@/components/common/spinner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api/client';
import { errorMessage, isApiError } from '@/lib/api/errors';
import type { OrgUnit, OrgUnitNotEmptyDetails, User } from '@/lib/api/types';
import { buildOrgUnitTree, descendantIds, orgUnitOptions, type OrgUnitNode } from '@/lib/org-units';
import { cn } from '@/lib/utils';
import { RoleBadge } from '@/components/users/user-badges';
import { OrgUnitNameDialog } from './org-unit-name-dialog';

type DialogState =
  | { kind: 'create'; parent: OrgUnit }
  | { kind: 'rename'; unit: OrgUnit }
  | { kind: 'move'; unit: OrgUnit }
  | { kind: 'delete'; unit: OrgUnit }
  | null;

/**
 * Org Unit Tree — screen-flow-inventory.md §2.4 / Flow 10. GET/POST/PATCH/
 * DELETE /org-units. Pick a unit to see who's directly in it. Owner/Admin get
 * per-unit actions (add sub-unit, rename, move, delete); the root unit can be
 * renamed but never moved or deleted, so those actions don't exist on it.
 * A delete blocked by 422 ORG_UNIT_NOT_EMPTY lists exactly what's still in the
 * unit, each linked to where it can be dealt with.
 */
export function OrgUnitTree({
  units,
  users,
  isAdmin,
  onChanged,
}: {
  units: OrgUnit[];
  users: User[];
  isAdmin: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const tree = useMemo(() => buildOrgUnitTree(units), [units]);
  const options = useMemo(() => orgUnitOptions(units), [units]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);

  const membersOf = useMemo(() => {
    const map = new Map<string, User[]>();
    for (const u of users) {
      if (u.status === 'deleted') continue;
      map.set(u.orgUnitId, [...(map.get(u.orgUnitId) ?? []), u]);
    }
    return map;
  }, [users]);

  if (!tree) return null;
  const selected = units.find((u) => u.id === selectedId) ?? tree;
  const selectedMembers = membersOf.get(selected.id) ?? [];
  const pathOf = (id: string) => options.find((o) => o.id === id)?.path ?? '';

  const renderNode = (node: OrgUnitNode): React.ReactNode => {
    const count = membersOf.get(node.id)?.length ?? 0;
    const isSelected = node.id === selected.id;
    const isRoot = node.parentOrgUnitId === null;
    return (
      <li key={node.id}>
        <div
          className={cn(
            'group flex items-center gap-2 rounded-md pr-1 transition-colors hover:bg-accent',
            isSelected && 'bg-accent',
          )}
          style={{ paddingLeft: `${node.depth * 1.25 + 0.5}rem` }}
        >
          <button
            type="button"
            onClick={() => setSelectedId(node.id)}
            className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left text-sm"
            aria-current={isSelected ? 'true' : undefined}
          >
            {isRoot ? (
              <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
            ) : (
              <CornerDownRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            )}
            <span className={cn('truncate', isSelected && 'font-medium')}>{node.name}</span>
            {isRoot && (
              <Badge variant="outline" className="px-1.5 text-[10px]">
                Root
              </Badge>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground" title={`${count} directly in this unit`}>
              <Users className="h-3 w-3" />
              {count}
            </span>
          </button>
          {isAdmin && (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Actions for ${node.name}`}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setDialog({ kind: 'create', parent: node })}>
                  <Plus /> Add sub-unit
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setDialog({ kind: 'rename', unit: node })}>
                  <Pencil /> Rename
                </DropdownMenuItem>
                {!isRoot && (
                  <>
                    <DropdownMenuItem onSelect={() => setDialog({ kind: 'move', unit: node })}>
                      <MoveRight /> Move…
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onSelect={() => setDialog({ kind: 'delete', unit: node })}
                    >
                      <Trash2 /> Delete
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {node.children.length > 0 && <ul>{node.children.map(renderNode)}</ul>}
      </li>
    );
  };

  /** 422 ORG_UNIT_NOT_EMPTY → list what's in the way, each linked to where it's fixed. */
  const notEmptyMessage = (err: unknown): React.ReactNode | undefined => {
    if (!(isApiError(err) && err.code === 'ORG_UNIT_NOT_EMPTY')) return undefined;
    const d = (err.details ?? {}) as Partial<OrgUnitNotEmptyDetails>;
    const members = (d.memberUserIds ?? []).map((id) => users.find((u) => u.id === id)).filter(Boolean) as User[];
    const children = (d.childOrgUnitIds ?? []).map((id) => units.find((u) => u.id === id)).filter(Boolean) as OrgUnit[];
    const invites = d.pendingInviteIds ?? [];
    return (
      <Alert variant="warning">
        <TriangleAlert className="h-4 w-4" />
        <AlertTitle>Empty this unit first</AlertTitle>
        <AlertDescription className="space-y-2 text-foreground">
          {members.length > 0 && (
            <div>
              <p className="text-sm font-medium">
                {members.length} {members.length === 1 ? 'person' : 'people'} — move them to another unit:
              </p>
              <ul className="ml-4 list-disc text-sm">
                {members.map((m) => (
                  <li key={m.id}>
                    <Link href={`/admin/users/${m.id}`} className="underline underline-offset-4">
                      {m.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {children.length > 0 && (
            <div>
              <p className="text-sm font-medium">
                {children.length} sub-{children.length === 1 ? 'unit' : 'units'} — move or delete:
              </p>
              <ul className="ml-4 list-disc text-sm">
                {children.map((c) => (
                  <li key={c.id}>{c.name}</li>
                ))}
              </ul>
            </div>
          )}
          {invites.length > 0 && (
            <p className="text-sm">
              {invites.length} pending {invites.length === 1 ? 'invite places' : 'invites place'} someone here —{' '}
              <Link href="/admin/users?tab=invites" className="underline underline-offset-4">
                revoke {invites.length === 1 ? 'it' : 'them'}
              </Link>{' '}
              or wait for acceptance.
            </p>
          )}
        </AlertDescription>
      </Alert>
    );
  };

  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <Card className="lg:col-span-3">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <FolderTree className="h-4 w-4" /> Structure
          </CardTitle>
          <CardDescription>
            Org units describe how your organization is arranged. They don’t change anyone’s permissions.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul aria-label="Org units" className="-mx-2">
            {renderNode(tree)}
          </ul>
          {isAdmin && units.length === 1 && (
            <p className="mt-4 text-sm text-muted-foreground">
              Start by adding a unit under {tree.name}, e.g. “Engineering” or “Finance”.
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{selected.name}</CardTitle>
          <CardDescription>{pathOf(selected.id)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {selectedMembers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No one is directly in this unit.</p>
          ) : (
            <ul className="divide-y">
              {selectedMembers
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <Link href={`/admin/users/${m.id}`} className="text-sm font-medium hover:underline">
                        {m.name}
                      </Link>
                      <p className="truncate text-xs text-muted-foreground">{m.email}</p>
                    </div>
                    <RoleBadge role={m.role} />
                  </li>
                ))}
            </ul>
          )}
          {isAdmin && (
            <p className="text-xs text-muted-foreground">To move someone, open their user page and pick a new org unit.</p>
          )}
        </CardContent>
      </Card>

      <OrgUnitNameDialog
        open={dialog?.kind === 'create'}
        title="Add a sub-unit"
        description={dialog?.kind === 'create' ? `It will sit under ${pathOf(dialog.parent.id)}.` : undefined}
        submitLabel="Add unit"
        onOpenChange={(o) => !o && setDialog(null)}
        onSubmit={async (name) => {
          if (dialog?.kind !== 'create') return;
          const created = await api<OrgUnit>('/org-units', {
            method: 'POST',
            body: { name, parentOrgUnitId: dialog.parent.id },
          });
          await onChanged();
          setSelectedId(created.id);
          toast.success(`Added ${name}`);
        }}
      />

      <OrgUnitNameDialog
        open={dialog?.kind === 'rename'}
        title="Rename unit"
        submitLabel="Save"
        initialName={dialog?.kind === 'rename' ? dialog.unit.name : ''}
        onOpenChange={(o) => !o && setDialog(null)}
        onSubmit={async (name) => {
          if (dialog?.kind !== 'rename') return;
          await api(`/org-units/${dialog.unit.id}`, { method: 'PATCH', body: { name } });
          await onChanged();
          toast.success('Unit renamed');
        }}
      />

      {dialog?.kind === 'move' && (
        <MoveDialog
          unit={dialog.unit}
          units={units}
          onClose={() => setDialog(null)}
          onMoved={async (parentPath) => {
            await onChanged();
            toast.success(`Moved under ${parentPath}`);
          }}
        />
      )}

      <ConfirmDialog
        open={dialog?.kind === 'delete'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={dialog?.kind === 'delete' ? `Delete ${dialog.unit.name}?` : 'Delete unit?'}
        description="Only empty units can be deleted: no people, no sub-units and no pending invites into it."
        confirmLabel="Delete unit"
        destructive
        describeError={notEmptyMessage}
        onConfirm={async () => {
          if (dialog?.kind !== 'delete') return;
          const unit = dialog.unit;
          await api(`/org-units/${unit.id}`, { method: 'DELETE' });
          if (selectedId === unit.id) setSelectedId(unit.parentOrgUnitId);
          await onChanged();
          toast.success(`Deleted ${unit.name}`);
        }}
      />
    </div>
  );
}

function MoveDialog({
  unit,
  units,
  onClose,
  onMoved,
}: {
  unit: OrgUnit;
  units: OrgUnit[];
  onClose: () => void;
  onMoved: (parentPath: string) => Promise<void>;
}) {
  const blocked = useMemo(() => descendantIds(units, unit.id), [units, unit.id]);
  const targets = useMemo(
    () => orgUnitOptions(units).filter((o) => !blocked.has(o.id) && o.id !== unit.parentOrgUnitId),
    [units, blocked, unit.parentOrgUnitId],
  );
  const [parentId, setParentId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const move = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/org-units/${unit.id}`, { method: 'PATCH', body: { parentOrgUnitId: parentId } });
      await onMoved(targets.find((t) => t.id === parentId)?.path ?? '');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move {unit.name}</DialogTitle>
          <DialogDescription>
            Its sub-units and people move with it. A unit can’t go inside one of its own sub-units.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {targets.length === 0 ? (
          <p className="text-sm text-muted-foreground">There’s nowhere else to move it yet.</p>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="move-target">New parent</Label>
            <Select value={parentId} onValueChange={setParentId}>
              <SelectTrigger id="move-target">
                <SelectValue placeholder="Choose a unit" />
              </SelectTrigger>
              <SelectContent>
                {targets.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.path}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={move} disabled={busy || !parentId}>
            {busy && <Spinner />}
            Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
