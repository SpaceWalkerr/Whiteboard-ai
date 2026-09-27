import { Link } from "react-router";
import { PLAN_LIMITS } from "@whiteboard/shared/entitlements";

export function AiReview() {
  return (
    <>
      <h2 id="how">How it works</h2>
      <ol>
        <li>
          Your board is turned into a typed graph: each system design shape becomes a component
          (service, database, cache, queue…) and each arrow a sync call, async message or
          replication link with its label.
        </li>
        <li>
          A deterministic rules engine finds obvious problems instantly — for example a database
          with no replica, a client talking straight to a database, a cycle of synchronous calls, a
          queue with no dead-letter queue, or media served without a CDN.
        </li>
        <li>
          Claude reviews the whole design, grounded in that graph and the rule findings, and returns
          a summary, a score for scalability, reliability, data design, security and cost, and
          findings with a severity and a suggested fix.
        </li>
        <li>
          Every finding is linked to the shapes it's about: select it to highlight them on the
          canvas. Run the review again after changes to see what's resolved.
        </li>
      </ol>

      <h2 id="check">Check design (free, instant)</h2>
      <p>
        <strong>Check design</strong> (<kbd>Shift</kbd> + <kbd>C</kbd>) runs only the rules engine.
        It needs no AI and doesn't use your review quota.
      </p>

      <h2 id="tips">Getting a better review</h2>
      <ul>
        <li>Use the typed system design shapes rather than plain rectangles.</li>
        <li>
          Label components and arrows with what they do (“GET /feed”, “Orders DB”, “3 instances”).
        </li>
        <li>Add the problem statement and requirements when you start the review.</li>
      </ul>

      <h2 id="quota">Quotas</h2>
      <p>
        Free includes {String(PLAN_LIMITS.free.aiReviewsPerMonth)} reviews a month, Pro{" "}
        {String(PLAN_LIMITS.pro.aiReviewsPerMonth)}, and Team{" "}
        {String(PLAN_LIMITS.team.aiReviewsPerMonth)} per seat, shared by the whole team. Quotas
        reset on the first day of each month (UTC).
      </p>

      <h2 id="hints">Live hints (Pro and Team)</h2>
      <p>
        With live hints on, you get short suggestions while you draw, without asking for a full
        review.
      </p>

      <h2 id="data">What is sent to the AI</h2>
      <p>
        Only the extracted graph — component kinds, labels and connections, plus the problem
        statement you give — never your name or email. On a private board nothing is sent unless you
        agree for that review. Details are in the <Link to="/privacy#ai">Privacy Policy</Link>. AI
        reviews can be wrong: treat them as a second opinion.
      </p>
    </>
  );
}
