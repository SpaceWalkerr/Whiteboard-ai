import { Link } from "react-router";
import { PLAN_LIMITS } from "@whiteboard/shared/entitlements";

export function Sharing() {
  return (
    <>
      <h2 id="roles">Roles</h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Role</th>
            <th scope="col">Can</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Owner</td>
            <td>Everything: edit, share, change roles, delete the board.</td>
          </tr>
          <tr>
            <td>Editor</td>
            <td>Draw and edit, run design checks and reviews.</td>
          </tr>
          <tr>
            <td>Viewer</td>
            <td>See the board live and run design checks and reviews; can't change anything.</td>
          </tr>
        </tbody>
      </table>
      <p>
        Permissions are enforced by our server on every request and every live connection, not just
        hidden in the interface.
      </p>

      <h2 id="ways">Ways to share</h2>
      <ul>
        <li>
          <strong>Invite by email</strong> as an editor or viewer. The person gets an email and the
          board appears under “Shared with me” once they sign in with that address.
        </li>
        <li>
          <strong>Share link</strong> with a role. Anyone who opens it and signs in gets that role.
          Revoke the link any time — people using it lose access within a second.
        </li>
        <li>
          <strong>Public read-only link</strong>: anyone signed in can view the board. Turn it off
          in the same dialog.
        </li>
        <li>
          <strong>Team workspaces</strong> (Team plan): members can open and edit the team's boards.
        </li>
      </ul>

      <h2 id="limits">Editor limits</h2>
      <p>
        A board can have up to {String(PLAN_LIMITS.free.editorsPerBoard)} editors on Free,{" "}
        {String(PLAN_LIMITS.pro.editorsPerBoard)} on Pro and{" "}
        {String(PLAN_LIMITS.team.editorsPerBoard)} on Team, the owner included; the owner's plan
        decides. Viewers don't count. When the limit is reached, new people join as viewers; the
        owner can free a seat from the Share dialog.
      </p>

      <h2 id="removing">Removing access</h2>
      <p>
        Removing a member, revoking a link or turning off public access takes effect immediately,
        including for people who have the board open. Their device also deletes its offline copy of
        the board. Private boards work differently — see{" "}
        <Link to="/docs/private-rooms">Private rooms</Link>.
      </p>
    </>
  );
}
