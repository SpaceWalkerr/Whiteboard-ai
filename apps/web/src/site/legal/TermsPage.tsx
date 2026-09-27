import { Link } from "react-router";
import { COMPANY } from "../config";
import { LegalPage } from "../layout/LegalPage";

export function TermsPage() {
  return (
    <LegalPage path="/terms" title="Terms of Service">
      <h2 id="agreement">1. Agreement</h2>
      <p>
        These Terms of Service (“Terms”) are an agreement between you and {COMPANY.legalName}
        (“we”, “us”) for the use of {COMPANY.productName}, including the website, the web
        application and related services (the “Service”). By creating an account or using the
        Service you agree to these Terms and to our <Link to="/privacy">Privacy Policy</Link>. If
        you use the Service for an organisation, you confirm you may accept these Terms on its
        behalf.
      </p>

      <h2 id="eligibility">2. Eligibility and accounts</h2>
      <p>
        You must be at least 18 years old, or the age of majority where you live, to use the
        Service. You sign in with an email link or with Google or GitHub. Keep access to that email
        or account secure: you are responsible for activity under your account. Tell us at{" "}
        {COMPANY.supportEmail} if you believe your account has been compromised.
      </p>

      <h2 id="service">3. The Service</h2>
      <p>
        {COMPANY.productName} is an online whiteboard for designing software systems. It lets you
        draw diagrams, collaborate in real time, share boards, request automated and AI-assisted
        design reviews and, on some plans, run interviews and use end-to-end encrypted private
        rooms. Features available to you depend on your plan, as described on the{" "}
        <Link to="/pricing">pricing page</Link>. We may improve, change or remove features; we will
        not remove a core paid feature during a period you have already paid for without a pro-rata
        refund.
      </p>

      <h2 id="plans">4. Plans, payment and taxes</h2>
      <ul>
        <li>
          The Free plan costs nothing. Paid plans (Pro and Team) are subscriptions billed monthly or
          yearly in advance through our payment partner, Razorpay. We never see or store your full
          card, UPI or bank details.
        </li>
        <li>
          Subscriptions renew automatically at the end of each billing period until cancelled.
          Prices are shown in Indian rupees and include applicable taxes (GST) unless stated
          otherwise.
        </li>
        <li>
          If a renewal payment fails we retry it and keep your plan active for a grace period; if it
          still fails your account moves to the Free plan. Your boards are never deleted because of
          a downgrade, but boards and editors above the Free limits become read-only.
        </li>
        <li>
          We may change prices for future billing periods. We will tell you at least 30 days before
          a price change affects you, and you may cancel before it takes effect.
        </li>
        <li>
          Cancellations and refunds are covered by our{" "}
          <Link to="/refund-policy">Refund and Cancellation Policy</Link>, which forms part of these
          Terms.
        </li>
      </ul>

      <h2 id="content">5. Your content</h2>
      <p>
        You own the boards, diagrams, notes and other material you create (“Your Content”). You give
        us a limited licence to host, copy, process, transmit and display Your Content only as
        needed to provide the Service to you and the people you share it with — for example to sync
        it between collaborators, generate thumbnails and exports, and run the design reviews you
        request. We do not sell Your Content or use it to train AI models.
      </p>
      <p>
        When you request an AI design review, a structured description of your diagram (its
        components, labels and connections) is sent to our AI provider to produce the review, as
        described in the <Link to="/privacy">Privacy Policy</Link>. Content in private rooms is
        encrypted in your browser; we cannot read it, and it is only sent for a review if you
        explicitly agree for that review.
      </p>

      <h2 id="acceptable-use">6. Acceptable use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>break the law, or infringe anyone's intellectual property or privacy;</li>
        <li>upload malware, or content that is abusive, obscene, defamatory or hateful;</li>
        <li>
          try to access boards or accounts you were not given, probe or disrupt the Service, or get
          around plan limits or security measures;
        </li>
        <li>
          scrape the Service, resell it, or use it to build a competing product, except as the law
          allows;
        </li>
        <li>send spam or unsolicited invitations through the Service.</li>
      </ul>

      <h2 id="ai">7. AI reviews</h2>
      <p>
        Design reviews are generated automatically, partly by an AI model. They can be wrong or
        incomplete. Treat them as suggestions, not professional advice, and use your own judgement
        before relying on them for real systems, interviews or hiring decisions.
      </p>

      <h2 id="interviews">8. Interview mode</h2>
      <p>
        If you use interview mode to assess candidates, you are responsible for your hiring process:
        for telling candidates how the session is recorded and used, for obtaining any consent the
        law requires, and for decisions you make. Scorecards and replays are yours to manage and
        delete.
      </p>

      <h2 id="availability">9. Availability and support</h2>
      <p>
        We aim to keep the Service available and to fix problems quickly, but it is provided on an
        “as is” and “as available” basis. Planned maintenance and events outside our control may
        interrupt it. Keep your own copies of important work: you can export any board as an image
        from the board's menu.
      </p>

      <h2 id="termination">10. Suspension and termination</h2>
      <p>
        You may stop using the Service at any time and ask us to delete your account by writing to{" "}
        {COMPANY.supportEmail} from the email address on the account. We may suspend or close an
        account that seriously or repeatedly breaks these Terms, or where the law requires it; where
        reasonable we will warn you first and let you export Your Content. After an account is
        deleted its data is permanently removed within 30 days, except records we must keep by law
        (such as invoices).
      </p>

      <h2 id="liability">11. Disclaimers and limitation of liability</h2>
      <p>
        To the extent the law allows, we disclaim implied warranties such as merchantability,
        fitness for a particular purpose and non-infringement. Neither party is liable for indirect
        or consequential losses, or for lost profits, revenue or data. Our total liability arising
        out of the Service in any 12-month period is limited to the amount you paid us in that
        period, or ₹1,000 if you use only the Free plan. Nothing in these Terms limits liability
        that cannot be limited by law.
      </p>

      <h2 id="indemnity">12. Indemnity</h2>
      <p>
        You will compensate us for reasonable losses and costs arising from Your Content or your
        breach of these Terms, when a third party brings a claim against us because of it.
      </p>

      <h2 id="law">13. Governing law and disputes</h2>
      <p>
        These Terms are governed by the laws of India. Before going to court, please contact us so
        we can try to resolve the issue informally. The courts at {COMPANY.jurisdictionCity}, India
        have exclusive jurisdiction, subject to any rights you have under consumer protection law to
        bring a claim where you live.
      </p>

      <h2 id="changes">14. Changes to these Terms</h2>
      <p>
        We may update these Terms. For material changes we will notify you by email or in the app at
        least 15 days before they take effect. If you keep using the Service after that, the new
        Terms apply; if you don't agree, you can cancel and ask us to delete your account.
      </p>

      <h2 id="contact">15. Contact and grievances</h2>
      <p>
        Questions about these Terms: {COMPANY.supportEmail}. Complaints can be sent to our Grievance
        Officer, {COMPANY.grievanceOfficerName}, at {COMPANY.grievanceOfficerEmail}; we acknowledge
        complaints within 24 hours and aim to resolve them within 15 days. Postal address:{" "}
        {COMPANY.address}. See also <Link to="/contact">Contact us</Link>.
      </p>
    </LegalPage>
  );
}
