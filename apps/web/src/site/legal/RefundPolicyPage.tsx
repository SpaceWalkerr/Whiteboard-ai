import { Link } from "react-router";
import { GRACE_PERIOD_DAYS, STUDENT_TRIAL_MONTHS } from "@whiteboard/shared/entitlements";
import { COMPANY, REFUND_PROCESSING, REFUND_WINDOW_DAYS } from "../config";
import { LegalPage } from "../layout/LegalPage";

export function RefundPolicyPage() {
  return (
    <LegalPage path="/refund-policy" title="Refund and Cancellation Policy">
      <p>
        This policy applies to paid {COMPANY.productName} subscriptions (Pro and Team) bought
        through our website and paid via Razorpay.
      </p>

      <h2 id="cancel">1. Cancelling a subscription</h2>
      <ul>
        <li>
          You can cancel at any time from <strong>Plan and billing</strong> in your account (or by
          emailing {COMPANY.supportEmail}). Team subscriptions can be cancelled by the person who
          bought them or a team owner/admin.
        </li>
        <li>
          Cancellation stops future renewals. Your plan stays active until the end of the period you
          have already paid for, then your account moves to the Free plan. You won't be charged
          again.
        </li>
        <li>
          Your boards are never deleted when a plan ends. Boards and editors above the Free plan's
          limits become read-only until you upgrade again or remove some.
        </li>
      </ul>

      <h2 id="refunds">2. Refunds</h2>
      <ul>
        <li>
          <strong>First payment:</strong> if you're not happy, ask within{" "}
          {String(REFUND_WINDOW_DAYS)} days of your first payment on a plan and we'll refund it in
          full and end the subscription. This applies once per customer per plan.
        </li>
        <li>
          <strong>Renewals:</strong> renewal payments are not refunded, and there are no partial
          refunds for unused time in a billing period, because you keep full access until the period
          ends.
        </li>
        <li>
          <strong>Our mistakes:</strong> duplicate charges, a charge for a plan that was never
          activated, or a charge after you cancelled are refunded in full, whenever you tell us.
        </li>
        <li>
          <strong>Changing plans:</strong> moving to a higher plan or more Team seats takes effect
          immediately, and the amount is shown before you confirm; moving to a lower plan or fewer
          seats takes effect at the next renewal, so there is nothing to refund.
        </li>
        <li>
          The student offer ({String(STUDENT_TRIAL_MONTHS)} months of Pro) is free and involves no
          payment.
        </li>
      </ul>

      <h2 id="how">3. How to request a refund</h2>
      <p>
        Email {COMPANY.supportEmail} from the address on your account with the Razorpay payment ID
        (it's on your receipt and under Invoices in billing settings). We reply{" "}
        {COMPANY.responseTime}. Approved refunds are issued to the original payment method and
        usually reach you in {REFUND_PROCESSING}, depending on your bank.
      </p>

      <h2 id="failed">4. Failed payments</h2>
      <p>
        If a renewal payment fails we'll email you and keep your plan active for{" "}
        {String(GRACE_PERIOD_DAYS)} days while Razorpay retries it. If it still hasn't gone through
        by then, your account moves to the Free plan; paying later restores your plan.
      </p>

      <h2 id="contact">5. Questions</h2>
      <p>
        See the <Link to="/docs/billing-faq">billing FAQ</Link> or{" "}
        <Link to="/contact">contact us</Link>.
      </p>
    </LegalPage>
  );
}
