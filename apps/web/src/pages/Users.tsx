import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button, Card, Chip, Sheet, Skeleton, Stamp } from "@camelthorn/ui";
import {
  ApiError,
  ROLES,
  StepUpRequired,
  inviteUser,
  listUsers,
  removeUser,
  restoreUser,
  revokeInvite,
  setUserRoles,
  stepUp,
  type InviteRow,
  type Role,
  type UserRow,
} from "../api";
import { useSignedIn } from "../auth";
import { useToast } from "../toasts";

export const ALLOWED_DOMAIN = "camelthorncapital.com";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Returns an error message, or null when the address may be invited. */
export function validateInviteEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (!email) return "Enter an email address.";
  if (!EMAIL_RE.test(email)) return "Enter a valid email address.";
  if (!email.endsWith(`@${ALLOWED_DOMAIN}`)) return `Use an @${ALLOWED_DOMAIN} email address.`;
  return null;
}

const ERROR_TEXT: Record<string, string> = {
  invalid_email: `Use an @${ALLOWED_DOMAIN} email address.`,
  invalid_roles: "Choose at least one role.",
  already_exists: "That person already has access or was already added.",
  last_admin: "There must always be one admin. Make someone else an admin first.",
  user_disabled: "That person was removed earlier. Restore them from the list.",
  not_disabled: "That person already has access. Reload the list.",
  not_found: "That user no longer exists. Reload the list.",
  forbidden: "Only admins can manage users.",
};

function describe(e: unknown): string {
  if (e instanceof ApiError) return ERROR_TEXT[e.code] ?? "Something went wrong. Try again.";
  return "Could not reach the server. Try again.";
}

export const ROLE_LABEL: Record<Role, string> = {
  admin: "Admin",
  approver: "Approver",
  finance: "Finance",
  viewer: "Viewer",
};

function RolePicker({
  value,
  onChange,
  legend,
}: {
  value: Role[];
  onChange: (r: Role[]) => void;
  legend: string;
}) {
  return (
    <fieldset className="roles">
      <legend>{legend}</legend>
      {ROLES.map((r) => (
        <label key={r} className="check-row">
          <input
            className="check"
            type="checkbox"
            checked={value.includes(r)}
            onChange={(e) =>
              onChange(e.target.checked ? [...value, r] : value.filter((x) => x !== r))
            }
          />
          <span>{ROLE_LABEL[r]}</span>
        </label>
      ))}
    </fieldset>
  );
}

type Dialog =
  | null
  | { kind: "stepup" }
  | { kind: "roles"; user: UserRow }
  | { kind: "remove"; user: UserRow }
  | { kind: "restore"; user: UserRow }
  | { kind: "revoke"; invite: InviteRow };

function countLine(users: number, invites: number): string {
  const people = `${users} ${users === 1 ? "person" : "people"} with access`;
  return invites === 0 ? people : `${people}, ${invites} invite${invites === 1 ? "" : "s"} pending`;
}

export function Users() {
  const toast = useToast();
  const me = useSignedIn();
  const [data, setData] = useState<{ users: UserRow[]; invites: InviteRow[]; at: number } | null>(
    null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);

  const load = useCallback(async () => {
    try {
      const r = await listUsers();
      setData({ ...r, at: Date.now() });
      setLoadError(null);
    } catch (e) {
      setLoadError(describe(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // Invite form
  const [email, setEmail] = useState("");
  const [inviteRoles, setInviteRoles] = useState<Role[]>(["viewer"]);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitInvite(e: FormEvent) {
    e.preventDefault();
    const problem =
      validateInviteEmail(email) ?? (inviteRoles.length === 0 ? "Choose at least one role." : null);
    if (problem) return setInviteError(problem);
    setInviteError(null);
    setBusy(true);
    try {
      const clean = email.trim().toLowerCase();
      await inviteUser(clean, inviteRoles);
      toast.show(`Added ${clean}. They can sign in with Google now.`);
      setEmail("");
      setInviteRoles(["viewer"]);
      await load();
    } catch (err) {
      if (err instanceof StepUpRequired) setDialog({ kind: "stepup" });
      else if (err instanceof ApiError && err.code === "user_disabled") {
        // Removed earlier: offer Restore instead of a dead end.
        const removed = data?.users.find(
          (u) => u.disabled && u.email === email.trim().toLowerCase(),
        );
        if (removed) openDialog({ kind: "restore", user: removed });
        else setInviteError(describe(err));
      } else setInviteError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  // Role change / removal sheets
  const [sheetRoles, setSheetRoles] = useState<Role[]>([]);
  const [sheetError, setSheetError] = useState<string | null>(null);

  function openDialog(d: Dialog) {
    setSheetError(null);
    if (d?.kind === "roles") setSheetRoles(d.user.roles);
    if (d?.kind === "restore") setSheetRoles(["viewer"]);
    setDialog(d);
  }

  async function runSheet(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setSheetError(null);
    try {
      await action();
      setDialog(null);
      toast.show(done);
      await load();
    } catch (err) {
      if (err instanceof StepUpRequired) setDialog({ kind: "stepup" });
      else setSheetError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card>
        <h2 className="h2">Add a person</h2>
        <p className="lede">
          People can sign in with Google only after an admin adds their @{ALLOWED_DOMAIN} email. No
          email is sent. Once added, they can sign in with Google now.
        </p>
        <form onSubmit={submitInvite} noValidate className="form">
          <label className="field">
            Email
            <input
              className="input"
              type="email"
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={inviteError !== null && validateInviteEmail(email) !== null}
              aria-describedby={inviteError ? "invite-error" : undefined}
              placeholder={`name@${ALLOWED_DOMAIN}`}
            />
          </label>
          <RolePicker legend="Roles" value={inviteRoles} onChange={setInviteRoles} />
          {inviteError && (
            <p id="invite-error" role="alert" className="notice warn">
              {inviteError}
            </p>
          )}
          <div>
            <Button type="submit" variant="primary" disabled={busy}>
              Add person
            </Button>
          </div>
        </form>
      </Card>

      <Card aria-busy={!data && !loadError}>
        <div className="row-between">
          <h2 className="h2">People</h2>
          {data && <Stamp at={data.at} />}
        </div>
        {data && (
          <p className="lede">
            {countLine(data.users.filter((u) => !u.disabled).length, data.invites.length)}
          </p>
        )}
        {loadError && (
          <p role="alert" className="notice warn">
            {loadError}
          </p>
        )}
        {!data && !loadError && (
          <div className="stack" role="status" aria-label="Loading users">
            <Skeleton height={20} />
            <Skeleton height={20} />
            <Skeleton height={20} width="70%" />
          </div>
        )}
        {data && (
          <div className="scroll">
            <table className="tbl stacked">
              <caption className="sr-only">Users</caption>
              <thead>
                <tr>
                  <th scope="col">Email</th>
                  <th scope="col">Roles</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.users.map((u) => (
                  <tr key={`u${u.id}`}>
                    <td>{u.email}</td>
                    <td>
                      {u.disabled ? (
                        <Chip>Removed</Chip>
                      ) : (
                        <span className="chips">
                          {u.roles.length === 0 && <Chip>No roles</Chip>}
                          {u.roles.map((r) => (
                            <Chip key={r} tone={r === "admin" ? "ok" : undefined}>
                              {ROLE_LABEL[r]}
                            </Chip>
                          ))}
                        </span>
                      )}
                    </td>
                    <td className="r">
                      {u.disabled && (
                        <Button size="sm" onClick={() => openDialog({ kind: "restore", user: u })}>
                          Restore<span className="sr-only"> {u.email}</span>
                        </Button>
                      )}
                      {!u.disabled && (
                        <span className="chips">
                          <Button size="sm" onClick={() => openDialog({ kind: "roles", user: u })}>
                            Change roles<span className="sr-only"> for {u.email}</span>
                          </Button>
                          <Button size="sm" onClick={() => openDialog({ kind: "remove", user: u })}>
                            Remove<span className="sr-only"> {u.email}</span>
                          </Button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
                {data.invites.map((i) => (
                  <tr key={`i${i.id}`}>
                    <td>{i.email}</td>
                    <td>
                      <span className="chips">
                        <Chip tone="gold">Invited</Chip>
                        {i.roles.map((r) => (
                          <Chip key={r}>{ROLE_LABEL[r]}</Chip>
                        ))}
                      </span>
                    </td>
                    <td className="r">
                      <Button size="sm" onClick={() => openDialog({ kind: "revoke", invite: i })}>
                        Revoke<span className="sr-only"> invite for {i.email}</span>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Sheet
        open={dialog?.kind === "stepup"}
        title="Confirm it's you"
        onClose={() => setDialog(null)}
      >
        <p className="lede">
          This change needs a Google sign-in from the last 15 minutes. Sign in again, then repeat
          the change.
        </p>
        <div className="chips">
          <Button variant="primary" onClick={() => stepUp()}>
            Sign in again
          </Button>
          <Button onClick={() => setDialog(null)}>Cancel</Button>
        </div>
      </Sheet>

      <Sheet open={dialog?.kind === "roles"} title="Change roles" onClose={() => setDialog(null)}>
        {dialog?.kind === "roles" && (
          <>
            <p className="lede">{dialog.user.email}</p>
            <RolePicker legend="Roles" value={sheetRoles} onChange={setSheetRoles} />
            {sheetRoles.length === 0 && (
              <p className="lede">Without any role this person can sign in but see nothing.</p>
            )}
            {dialog.user.email === me.email &&
              dialog.user.roles.includes("admin") &&
              !sheetRoles.includes("admin") && (
                <p className="notice warn">
                  This removes your own admin role. You can no longer manage users.
                </p>
              )}
            {sheetError && (
              <p role="alert" className="notice warn">
                {sheetError}
              </p>
            )}
            <div className="chips">
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  void runSheet(
                    () => setUserRoles(dialog.user.id, sheetRoles),
                    `Updated roles for ${dialog.user.email}.`,
                  )
                }
              >
                Save roles
              </Button>
              <Button onClick={() => setDialog(null)}>Cancel</Button>
            </div>
          </>
        )}
      </Sheet>

      <Sheet
        open={dialog?.kind === "restore"}
        title="Restore this person"
        onClose={() => setDialog(null)}
      >
        {dialog?.kind === "restore" && (
          <>
            <p className="lede">
              {dialog.user.email} was removed. Choose the roles they get back. Their old roles are
              not kept.
            </p>
            <RolePicker legend="Roles" value={sheetRoles} onChange={setSheetRoles} />
            {sheetRoles.length === 0 && <p className="lede">Choose at least one role.</p>}
            {sheetError && (
              <p role="alert" className="notice warn">
                {sheetError}
              </p>
            )}
            <div className="chips">
              <Button
                variant="primary"
                disabled={busy || sheetRoles.length === 0}
                onClick={() =>
                  void runSheet(
                    () => restoreUser(dialog.user.id, sheetRoles),
                    `Restored ${dialog.user.email}.`,
                  )
                }
              >
                Restore person
              </Button>
              <Button onClick={() => setDialog(null)}>Cancel</Button>
            </div>
          </>
        )}
      </Sheet>

      <Sheet
        open={dialog?.kind === "revoke"}
        title="Revoke this invite"
        onClose={() => setDialog(null)}
      >
        {dialog?.kind === "revoke" && (
          <>
            <p className="lede">
              {dialog.invite.email} will no longer be able to sign in. You can add them again later.
            </p>
            {sheetError && (
              <p role="alert" className="notice warn">
                {sheetError}
              </p>
            )}
            <div className="chips">
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  void runSheet(
                    () => revokeInvite(dialog.invite.id),
                    `Revoked the invite for ${dialog.invite.email}.`,
                  )
                }
              >
                Revoke invite
              </Button>
              <Button onClick={() => setDialog(null)}>Cancel</Button>
            </div>
          </>
        )}
      </Sheet>

      <Sheet
        open={dialog?.kind === "remove"}
        title="Remove this user"
        onClose={() => setDialog(null)}
      >
        {dialog?.kind === "remove" && (
          <>
            <p className="lede">
              {dialog.user.email} will be signed out now and can no longer sign in.
            </p>
            {dialog.user.email === me.email && (
              <p className="notice warn">This is your own account. You are signed out at once.</p>
            )}
            {sheetError && (
              <p role="alert" className="notice warn">
                {sheetError}
              </p>
            )}
            <div className="chips">
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  void runSheet(() => removeUser(dialog.user.id), `Removed ${dialog.user.email}.`)
                }
              >
                Remove user
              </Button>
              <Button onClick={() => setDialog(null)}>Cancel</Button>
            </div>
          </>
        )}
      </Sheet>
    </>
  );
}
