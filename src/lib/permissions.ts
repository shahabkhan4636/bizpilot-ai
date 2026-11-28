/**
 * Central authorisation model.
 *
 * Roles and their capabilities live here and nowhere else. Every server action
 * and API route asks this module — never the browser, never a role string sent in
 * a form. `src/lib/auth.ts` wraps these checks with the session guard.
 *
 *   owner    full control, including billing and workspace deletion
 *   admin    everything operational, including the team and workspace settings
 *   manager  day-to-day sales management: leads, proposals, automations, approvals
 *   member   sales representative: own leads and proposals, AI drafts, own documents
 *   viewer   read-only (stakeholders, finance, auditors)
 */

export const ROLES = ["owner", "admin", "manager", "member", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  member: "Sales rep",
  viewer: "Viewer",
};

export const ROLE_DESCRIPTION: Record<Role, string> = {
  owner: "Full control, including billing and deleting the workspace.",
  admin: "Manage the team, workspace settings and every record.",
  manager: "Manage leads, proposals, automations and approvals.",
  member: "Work the pipeline: their own leads, proposals and AI drafts.",
  viewer: "Read-only access to records and reports.",
};

export const PERMISSIONS = [
  "lead:read",
  "lead:write",
  "lead:delete",
  "customer:read",
  "customer:write",
  "customer:delete",
  "proposal:read",
  "proposal:write",
  "proposal:delete",
  "document:read",
  "document:upload",
  "document:delete",
  "automation:read",
  "automation:manage",
  "approval:read",
  "approval:act",
  "ai:generate",
  "analytics:read",
  "export:data",
  "settings:profile",
  "settings:workspace",
  "team:manage",
  "billing:manage",
  "workspace:delete",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * The permissions that read or describe, never mutate.
 *
 * Exported because impersonation needs exactly this list: "read-only impersonation"
 * means every permission *not* in here is refused, so a new write permission added
 * later is refused by default rather than silently allowed.
 */
export const READ_ONLY_PERMISSIONS: Permission[] = [
  "lead:read",
  "customer:read",
  "proposal:read",
  "document:read",
  "automation:read",
  "approval:read",
  "analytics:read",
  "settings:profile",
];

/** True when the permission can change data (i.e. is not in the read-only set). */
export function isWritePermission(permission: Permission): boolean {
  return !READ_ONLY_PERMISSIONS.includes(permission);
}

const GRANTS: Record<Role, Permission[]> = {
  owner: [...PERMISSIONS],
  admin: PERMISSIONS.filter((p) => p !== "workspace:delete"),
  manager: [
    ...READ_ONLY_PERMISSIONS,
    "lead:write",
    "lead:delete",
    "customer:write",
    "customer:delete",
    "proposal:write",
    "proposal:delete",
    "document:upload",
    "document:delete",
    "automation:manage",
    "approval:act",
    "ai:generate",
    "export:data",
  ],
  member: [
    ...READ_ONLY_PERMISSIONS,
    "lead:write",
    "customer:write",
    "proposal:write",
    "document:upload",
    "ai:generate",
    "export:data",
  ],
  viewer: [...READ_ONLY_PERMISSIONS],
};

export function can(role: string, permission: Permission): boolean {
  const grants = GRANTS[role as Role];
  if (!grants) return false; // unknown role: deny, never allow
  return grants.includes(permission);
}

export function permissionsFor(role: string): Permission[] {
  return [...(GRANTS[role as Role] ?? [])];
}

export function isReadOnly(role: string): boolean {
  return role === "viewer";
}

/** True for roles that may change the workspace itself (name, currency, timezone). */
export function canManageWorkspace(role: string): boolean {
  return can(role, "settings:workspace");
}

/** True for roles that may invite, remove and re-role members. */
export function canManageTeam(role: string): boolean {
  return can(role, "team:manage");
}

/**
 * Ownership rule for records that carry an `assigned_to`: a sales rep may edit
 * their own records, managers and above may edit anyone's. Viewers never write.
 */
export function canEditOwnedRecord(role: string, userId: string, ownerId: string | null, permission: Permission): boolean {
  if (!can(role, permission)) return false;
  if (role === "owner" || role === "admin" || role === "manager") return true;
  return ownerId === null ? true : ownerId === userId;
}
