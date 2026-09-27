import { Link } from "react-router";
import { COMPANY } from "../config";
import { LegalPage } from "../layout/LegalPage";

export function ShippingPolicyPage() {
  return (
    <LegalPage path="/shipping-policy" title="Shipping and Delivery Policy">
      <h2 id="digital">1. A digital service — nothing is shipped</h2>
      <p>
        {COMPANY.productName} is software used in your web browser. We don't sell or ship physical
        goods, so there are no shipping charges, couriers or delivery addresses involved.
      </p>

      <h2 id="delivery">2. How and when you receive what you buy</h2>
      <ul>
        <li>
          A paid plan is delivered to your {COMPANY.productName} account as soon as Razorpay
          confirms the payment — usually within a few seconds. The plan's features unlock
          immediately; you don't need to sign in again.
        </li>
        <li>
          We email a receipt to the address on your account. Your invoices are also listed under
          Plan and billing.
        </li>
        <li>The Service is available anywhere with an internet connection and a modern browser.</li>
      </ul>

      <h2 id="problems">3. If your plan isn't active</h2>
      <p>
        If you've been charged but your plan isn't active within one hour, email{" "}
        {COMPANY.supportEmail} with the Razorpay payment ID. We'll activate it or refund you in
        full, as described in our <Link to="/refund-policy">Refund and Cancellation Policy</Link>.
      </p>
    </LegalPage>
  );
}
