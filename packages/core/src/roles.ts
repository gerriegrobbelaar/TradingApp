/**
 * Roles are NOT hierarchical: a user holds exactly the roles granted explicitly. Admin does not
 * imply finance, approver or viewer (see docs/decisions/0008).
 */
export const ROLES = ["admin", "approver", "finance", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}
