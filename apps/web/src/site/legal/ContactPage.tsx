import { Mail, MapPin, Phone, ShieldCheck } from "lucide-react";
import { COMPANY } from "../config";
import { usePageTitle } from "../layout/usePageTitle";
import { STATIC_PAGES } from "../meta";

export function ContactPage() {
  usePageTitle(STATIC_PAGES["/contact"].title);
  return (
    <div className="prose-site mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <h1>Contact us</h1>
      <p>
        Questions about your account, billing or privacy? We reply {COMPANY.responseTime} (
        {COMPANY.supportHours}). For billing questions, include the Razorpay payment ID from your
        receipt.
      </p>
      <dl className="not-prose mt-8 grid gap-6 sm:grid-cols-2">
        <div className="rounded-lg border p-5">
          <dt className="flex items-center gap-2 font-semibold">
            <Mail className="size-4" aria-hidden="true" /> Email
          </dt>
          <dd className="mt-2">
            <a href={`mailto:${COMPANY.supportEmail}`} className="underline">
              {COMPANY.supportEmail}
            </a>
          </dd>
        </div>
        <div className="rounded-lg border p-5">
          <dt className="flex items-center gap-2 font-semibold">
            <Phone className="size-4" aria-hidden="true" /> Phone
          </dt>
          <dd className="mt-2">
            <a href={`tel:${COMPANY.phone.replace(/[^+\d]/g, "")}`} className="underline">
              {COMPANY.phone}
            </a>
          </dd>
        </div>
        <div className="rounded-lg border p-5 sm:col-span-2">
          <dt className="flex items-center gap-2 font-semibold">
            <MapPin className="size-4" aria-hidden="true" /> Postal address
          </dt>
          <dd className="mt-2">
            <address className="not-italic">
              {COMPANY.legalName}
              <br />
              {COMPANY.address}
            </address>
          </dd>
        </div>
        <div className="rounded-lg border p-5 sm:col-span-2">
          <dt className="flex items-center gap-2 font-semibold">
            <ShieldCheck className="size-4" aria-hidden="true" /> Grievance Officer
          </dt>
          <dd className="mt-2">
            {COMPANY.grievanceOfficerName} —{" "}
            <a href={`mailto:${COMPANY.grievanceOfficerEmail}`} className="underline">
              {COMPANY.grievanceOfficerEmail}
            </a>
            . Complaints are acknowledged within 24 hours and resolved within 15 days.
          </dd>
        </div>
      </dl>
    </div>
  );
}
