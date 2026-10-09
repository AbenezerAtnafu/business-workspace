import type { OrgUnit } from '@/lib/api/types';

export interface OrgUnitOption {
  id: string;
  /** "Acme / Engineering / Backend" */
  path: string;
  depth: number;
  isRoot: boolean;
}

/**
 * Flattens GET /org-units (already tree-ordered by the backend) into picker
 * options with a readable path, so a user's unit reads "Engineering /
 * Backend" rather than a bare name that may repeat across branches.
 */
export function orgUnitOptions(units: OrgUnit[]): OrgUnitOption[] {
  const byId = new Map(units.map((u) => [u.id, u]));
  const pathOf = (u: OrgUnit): string[] => {
    const parts: string[] = [];
    let cur: OrgUnit | undefined = u;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      parts.unshift(cur.name);
      cur = cur.parentOrgUnitId ? byId.get(cur.parentOrgUnitId) : undefined;
    }
    return parts;
  };
  return units.map((u) => {
    const parts = pathOf(u);
    return { id: u.id, path: parts.join(' / '), depth: parts.length - 1, isRoot: u.parentOrgUnitId === null };
  });
}

export interface OrgUnitNode extends OrgUnit {
  children: OrgUnitNode[];
  depth: number;
}

/** Builds the tree from GET /org-units' flat list. Children keep the backend's (name-sorted) order. */
export function buildOrgUnitTree(units: OrgUnit[]): OrgUnitNode | null {
  const nodes = new Map<string, OrgUnitNode>(units.map((u) => [u.id, { ...u, children: [], depth: 0 }]));
  let root: OrgUnitNode | null = null;
  for (const u of units) {
    const node = nodes.get(u.id)!;
    if (u.parentOrgUnitId === null) root = node;
    else nodes.get(u.parentOrgUnitId)?.children.push(node);
  }
  const setDepth = (n: OrgUnitNode, d: number) => {
    n.depth = d;
    n.children.forEach((c) => setDepth(c, d + 1));
  };
  if (root) setDepth(root, 0);
  return root;
}

/** The unit itself plus every descendant — never valid as a "move under" target for it. */
export function descendantIds(units: OrgUnit[], id: string): Set<string> {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const u of units) {
      if (u.parentOrgUnitId && out.has(u.parentOrgUnitId) && !out.has(u.id)) {
        out.add(u.id);
        grew = true;
      }
    }
  }
  return out;
}
