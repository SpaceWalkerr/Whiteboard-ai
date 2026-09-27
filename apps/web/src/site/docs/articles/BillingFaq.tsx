import { Link } from "react-router";
import {
  GRACE_PERIOD_DAYS,
  PLAN_LIMITS,
  STUDENT_TRIAL_MONTHS,
} from "@whiteboard/shared/entitlements";
import { REFUND_WINDOW_DAYS } from "../../config";

export function BillingFaq() {
  return (
    <>
      <h2 id="pay">How can I pay?</h2>
      <p>
        Cards, UPI, net banking and wallets supported by Razorpay, in Indian rupees. Payments are
        processed by Razorpay; we never see your card or bank details. International (USD) billing
        is coming.
      </p>

      <h2 id="invoices">Where are my invoices?</h2>
      <p>
        Under <strong>Plan and billing</strong> in the account menu, with a receipt link for each
        payment. We also email a receipt after every successful payment.
      </p>

      <h2 id="yearly">Is yearly cheaper?</h2>
      <p>Yes — yearly costs the same as 10 months, so you get 2 months free.</p>

      <h2 id="team">How does Team billing work?</h2>
      <p>
        Team is billed per seat (every member, the owner included). Owners and admins add or remove
        members up to the number of seats. Adding seats takes effect immediately; removing seats
        takes effect at the next renewal. AI reviews are pooled:{" "}
        {String(PLAN_LIMITS.team.aiReviewsPerMonth)} per seat, shared by the team.
      </p>

      <h2 id="cancel">How do I cancel?</h2>
      <p>
        In Plan and billing choose <strong>Cancel subscription</strong>. You keep the plan until the
        end of the period you paid for and won't be charged again.
      </p>

      <h2 id="refund">Can I get a refund?</h2>
      <p>
        A first payment on a plan is refunded in full if you ask within {String(REFUND_WINDOW_DAYS)}{" "}
        days. Duplicate or mistaken charges are always refunded. Details in the{" "}
        <Link to="/refund-policy">Refund and Cancellation Policy</Link>.
      </p>

      <h2 id="failed">What if a payment fails?</h2>
      <p>
        We email you and keep your plan for {String(GRACE_PERIOD_DAYS)} days while the payment is
        retried. After that your account moves to Free.
      </p>

      <h2 id="downgrade">What happens to my boards if I downgrade?</h2>
      <p>
        Nothing is deleted. If you have more than {String(PLAN_LIMITS.free.boards)} boards, the most
        recently edited ones stay editable and the rest become read-only until you upgrade again or
        move some to the trash.
      </p>

      <h2 id="students">Is there a student discount?</h2>
      <p>
        Students get Pro free for {String(STUDENT_TRIAL_MONTHS)} months: sign in with your
        university email (.edu or .ac.in) and claim it in Plan and billing. No card needed.
      </p>

      <h2 id="gst">Do prices include GST?</h2>
      <p>
        Yes, prices shown in INR include applicable taxes. Need a GST invoice for your business?{" "}
        <Link to="/contact">Contact us</Link>.
      </p>
    </>
  );
}
