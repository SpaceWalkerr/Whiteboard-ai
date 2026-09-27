import { Link } from "react-router";
import { PLAN_LIMITS } from "@whiteboard/shared/entitlements";

export function GettingStarted() {
  return (
    <>
      <h2 id="sign-in">1. Sign in</h2>
      <p>
        Go to <Link to="/sign-in">Sign in</Link> and use your email (we send a one-time link) or
        your Google or GitHub account. Signing in the first time creates your account and a personal
        workspace. The Free plan gives you {String(PLAN_LIMITS.free.boards)} boards — no card
        needed.
      </p>

      <h2 id="board">2. Create a board</h2>
      <p>
        On your dashboard choose <strong>New board</strong>, or start from one of the{" "}
        <Link to="/templates">system design templates</Link>. Boards live in your workspace; you can
        put them in folders, rename, duplicate and move them to the trash (restorable for 30 days).
      </p>

      <h2 id="draw">3. Draw your architecture</h2>
      <ul>
        <li>
          Pick a tool from the toolbar or press its key: <kbd>R</kbd> rectangle, <kbd>O</kbd>{" "}
          ellipse, <kbd>T</kbd> text, <kbd>N</kbd> sticky note, <kbd>P</kbd> pen, <kbd>A</kbd>{" "}
          arrow.
        </li>
        <li>
          Add system design components — client, CDN, load balancer, API gateway, service, database,
          cache, queue, object storage, search index, worker, external API — from the shape library,
          or press <kbd>/</kbd> and type a name. With a shape selected, the new one is connected to
          it automatically.
        </li>
        <li>
          Drag an arrow between two shapes: it stays attached when they move. Give it a label and a
          type — sync call, async message or replication — in the properties panel.
        </li>
        <li>
          Scroll to pan (or hold <kbd>Space</kbd> and drag), and zoom with a pinch or{" "}
          <kbd>Ctrl/⌘</kbd> + scroll. All shortcuts are in{" "}
          <Link to="/docs/shortcuts">Keyboard shortcuts</Link> or press <kbd>?</kbd> on a board.
        </li>
      </ul>

      <h2 id="collaborate">4. Invite your team</h2>
      <p>
        Use <strong>Share</strong> to invite people by email or create a link. Everyone sees each
        other's cursors and changes live. If you lose your connection keep working — your edits are
        saved on your device and merge when you're back online. See{" "}
        <Link to="/docs/sharing-and-permissions">Sharing and permissions</Link>.
      </p>

      <h2 id="review">5. Check and review the design</h2>
      <p>
        <strong>Check design</strong> (<kbd>Shift</kbd> + <kbd>C</kbd>) runs instant rule checks —
        no AI, no quota. <strong>AI review</strong> (<kbd>Shift</kbd> + <kbd>R</kbd>) asks Claude
        for a full review with findings pinned to your shapes. See{" "}
        <Link to="/docs/ai-review">AI design review</Link>.
      </p>
    </>
  );
}
