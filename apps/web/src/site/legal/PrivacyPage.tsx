import { Link } from "react-router";
import { COMPANY } from "../config";
import { LegalPage } from "../layout/LegalPage";

/** Who processes personal data for us, and why. Keep in step with the real integrations. */
const PROCESSORS = [
  {
    name: "Supabase",
    purpose: "Database, sign-in and file storage (thumbnails, exports)",
    location: "Singapore",
  },
  { name: "Render", purpose: "Application servers and real-time sync", location: "Singapore" },
  {
    name: "Vercel",
    purpose: "Hosting of the website and web app",
    location: "Global edge network",
  },
  {
    name: "Anthropic",
    purpose: "AI design reviews and live hints (only when you request them)",
    location: "United States",
  },
  { name: "Razorpay", purpose: "Payments and subscriptions", location: "India" },
  { name: "Resend", purpose: "Sign-in and account emails, receipts", location: "United States" },
  { name: "Sentry", purpose: "Error reports from the app and servers", location: "United States" },
  {
    name: "PostHog",
    purpose: "Product analytics — only if you accept analytics cookies",
    location: "European Union",
  },
] as const;

export function PrivacyPage() {
  return (
    <LegalPage path="/privacy" title="Privacy Policy">
      <p>
        This policy explains what personal data {COMPANY.legalName} (“we”) collects when you use{" "}
        {COMPANY.productName}, why, who we share it with and the choices you have. We process
        personal data in line with India's Digital Personal Data Protection Act, 2023 and the
        Information Technology Act, 2000 and its rules.
      </p>

      <h2 id="data">1. Data we collect</h2>
      <ul>
        <li>
          <strong>Account data:</strong> your email address and, if you sign in with Google or
          GitHub, your name and profile picture from that account.
        </li>
        <li>
          <strong>Your content:</strong> boards, shapes, labels, comments, interview notes and
          scorecards you create, and who you share them with. Private-room content is encrypted in
          your browser; we store only ciphertext we cannot read.
        </li>
        <li>
          <strong>Billing data:</strong> your plan, subscription status, invoice amounts and the
          payment reference Razorpay gives us. Card, UPI and bank details are collected by Razorpay,
          never by us.
        </li>
        <li>
          <strong>Technical data:</strong> IP address, browser type, request logs and error reports,
          used to run and secure the Service.
        </li>
        <li>
          <strong>Analytics (optional):</strong> which pages and features you use, only if you
          accept analytics cookies.
        </li>
        <li>
          <strong>Messages:</strong> what you send us when you contact support.
        </li>
      </ul>

      <h2 id="use">2. How we use it</h2>
      <ul>
        <li>to provide the Service: sign you in, save and sync your boards, share them;</li>
        <li>to run the design reviews and hints you ask for;</li>
        <li>to take payments, send receipts and manage your plan;</li>
        <li>to send service emails (sign-in links, invitations, billing notices);</li>
        <li>to keep the Service secure, prevent abuse and fix errors;</li>
        <li>with your consent, to understand how the product is used and improve it;</li>
        <li>to meet legal obligations such as tax and accounting records.</li>
      </ul>
      <p>We do not sell personal data, show advertising, or use your content to train AI models.</p>

      <h2 id="ai">3. AI reviews</h2>
      <p>
        When you request a design review or turn on live hints, we send a structured description of
        the board — its components, their labels and the connections between them — to Anthropic's
        Claude API, which returns the review. We don't send your name or email. Anthropic processes
        this data under its commercial terms for API customers. In a private room nothing is sent
        unless you explicitly agree for that particular review, and then only the extracted
        description of the diagram.
      </p>

      <h2 id="sharing">4. Who we share it with</h2>
      <p>
        We share personal data only with the service providers below, who process it on our behalf
        under contracts that require them to protect it, with people you choose to share boards
        with, and with authorities when the law requires it.
      </p>
      <div className="overflow-x-auto">
        <table>
          <caption className="sr-only">Service providers that process personal data</caption>
          <thead>
            <tr>
              <th scope="col">Provider</th>
              <th scope="col">Purpose</th>
              <th scope="col">Location</th>
            </tr>
          </thead>
          <tbody>
            {PROCESSORS.map((p) => (
              <tr key={p.name}>
                <td>{p.name}</td>
                <td>{p.purpose}</td>
                <td>{p.location}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        Some providers process data outside India. We transfer data abroad only as Indian law
        permits and with safeguards appropriate to the data.
      </p>

      <h2 id="retention">5. How long we keep it</h2>
      <ul>
        <li>Account data and content: for as long as your account exists.</li>
        <li>
          Boards you move to the trash: permanently deleted 30 days later. A deleted account's data
          is permanently deleted within 30 days.
        </li>
        <li>Invoices and payment records: as long as Indian tax and accounting law requires.</li>
        <li>Server logs and error reports: up to 90 days.</li>
      </ul>

      <h2 id="security">6. Security</h2>
      <p>
        Data is encrypted in transit (HTTPS) and at rest by our hosting providers. Access to
        production systems is limited to people who need it. Private rooms add end-to-end
        encryption: the key lives in the board link and never reaches our servers. No system is
        perfectly secure; if a breach affects you we will tell you and the authorities as the law
        requires.
      </p>

      <h2 id="cookies">7. Cookies and similar storage</h2>
      <ul>
        <li>
          <strong>Essential (always on):</strong> your sign-in session, your cookie choice and your
          light/dark theme, stored in your browser. The Service can't work without the session.
        </li>
        <li>
          <strong>Analytics (off unless you accept):</strong> PostHog cookies that measure how the
          product is used. They are never set before you accept.
        </li>
      </ul>
      <p>
        We use no advertising cookies. You can change your choice any time with “Cookie settings” at
        the bottom of every page.
      </p>

      <h2 id="rights">8. Your rights</h2>
      <p>
        You can ask to access, correct or delete your personal data, withdraw a consent you gave
        (withdrawal doesn't affect processing before it), and nominate someone to exercise your
        rights if you die or become unable to. Email {COMPANY.supportEmail} from the address on your
        account; we reply within 30 days. You may also complain to our Grievance Officer (below)
        and, if not satisfied, to the Data Protection Board of India.
      </p>

      <h2 id="children">9. Children</h2>
      <p>
        The Service is for people aged 18 and over. We don't knowingly collect data from children;
        if you believe a child has given us data, contact us and we will delete it.
      </p>

      <h2 id="changes">10. Changes</h2>
      <p>
        We'll update this page when our practices change and tell you by email or in the app about
        material changes before they take effect.
      </p>

      <h2 id="contact">11. Contact and Grievance Officer</h2>
      <p>
        {COMPANY.legalName}, {COMPANY.address}. Email: {COMPANY.supportEmail}. Grievance Officer:{" "}
        {COMPANY.grievanceOfficerName}, {COMPANY.grievanceOfficerEmail}. See also{" "}
        <Link to="/contact">Contact us</Link>.
      </p>
    </LegalPage>
  );
}
