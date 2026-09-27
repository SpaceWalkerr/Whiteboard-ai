import type { ReactNode } from "react";
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  render,
  Text,
} from "@react-email/components";
import { formatMoney } from "@whiteboard/shared/billing";
import { PLAN_LIMITS, PLAN_NAMES, type Plan } from "@whiteboard/shared/entitlements";
import type { EmailMessage } from "./mailer";

const dateText = (date: Date) =>
  new Intl.DateTimeFormat("en-IN", { dateStyle: "long", timeZone: "Asia/Kolkata" }).format(date);

function Layout(props: {
  preview: string;
  heading: string;
  children: ReactNode;
  action: { label: string; href: string };
}) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{props.preview}</Preview>
      <Body
        style={{
          backgroundColor: "#f3f4f6",
          fontFamily: "Inter, Arial, sans-serif",
          padding: "24px 0",
        }}
      >
        <Container
          style={{ backgroundColor: "#ffffff", borderRadius: 8, padding: 32, maxWidth: 480 }}
        >
          <Heading as="h1" style={{ fontSize: 20, color: "#111827" }}>
            {props.heading}
          </Heading>
          {props.children}
          <Button
            href={props.action.href}
            style={{
              backgroundColor: "#111827",
              color: "#ffffff",
              borderRadius: 6,
              padding: "12px 20px",
              fontSize: 15,
            }}
          >
            {props.action.label}
          </Button>
          <Hr style={{ margin: "24px 0", borderColor: "#e5e7eb" }} />
          <Text style={{ color: "#6b7280", fontSize: 13 }}>
            You're receiving this because you manage a Whiteboard.ai subscription. Questions about a
            charge? Reply to this email.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

const P = ({ children }: { children: ReactNode }) => (
  <Text style={{ color: "#374151", fontSize: 15 }}>{children}</Text>
);

async function message(to: string, subject: string, element: ReactNode): Promise<EmailMessage> {
  return {
    to,
    subject,
    html: await render(element),
    text: await render(element, { plainText: true }),
  };
}

export interface ReceiptProps {
  plan: Plan;
  amountMinor: number;
  currency: string;
  paidAt: Date;
  periodEnd: Date | null;
  receiptUrl: string | null;
  billingUrl: string;
}

export function receiptEmail(to: string, props: ReceiptProps): Promise<EmailMessage> {
  const amount = formatMoney(props.amountMinor, props.currency);
  return message(
    to,
    `Payment received: ${amount} for Whiteboard.ai ${PLAN_NAMES[props.plan]}`,
    <Layout
      preview={`We received ${amount}. Thank you!`}
      heading="Payment received — thank you"
      action={
        props.receiptUrl
          ? { label: "View receipt", href: props.receiptUrl }
          : { label: "Billing settings", href: props.billingUrl }
      }
    >
      <P>
        We received <strong>{amount}</strong> on {dateText(props.paidAt)} for your{" "}
        {PLAN_NAMES[props.plan]} plan.
      </P>
      {props.periodEnd ? <P>Your plan is paid through {dateText(props.periodEnd)}.</P> : null}
    </Layout>,
  );
}

export interface PaymentFailedProps {
  plan: Plan;
  graceUntil: Date;
  paymentUrl: string | null;
  billingUrl: string;
}

export function paymentFailedEmail(to: string, props: PaymentFailedProps): Promise<EmailMessage> {
  return message(
    to,
    `Your Whiteboard.ai payment didn't go through`,
    <Layout
      preview={`Your ${PLAN_NAMES[props.plan]} plan stays active until ${dateText(props.graceUntil)}.`}
      heading="We couldn't take your payment"
      action={{
        label: props.paymentUrl ? "Update payment method" : "Billing settings",
        href: props.paymentUrl ?? props.billingUrl,
      }}
    >
      <P>
        The renewal payment for your {PLAN_NAMES[props.plan]} plan failed. We'll retry
        automatically. Nothing changes yet: your plan stays active until{" "}
        <strong>{dateText(props.graceUntil)}</strong>.
      </P>
      <P>
        If the payment still hasn't gone through by then, your account moves to the Free plan. Your
        boards are never deleted.
      </P>
    </Layout>,
  );
}

export function graceReminderEmail(to: string, props: PaymentFailedProps): Promise<EmailMessage> {
  return message(
    to,
    `Action needed: your Whiteboard.ai plan ends on ${dateText(props.graceUntil)}`,
    <Layout
      preview={`Update your payment method to keep ${PLAN_NAMES[props.plan]}.`}
      heading={`Your ${PLAN_NAMES[props.plan]} plan ends soon`}
      action={{
        label: props.paymentUrl ? "Update payment method" : "Billing settings",
        href: props.paymentUrl ?? props.billingUrl,
      }}
    >
      <P>
        We still couldn't take the payment for your {PLAN_NAMES[props.plan]} plan. On{" "}
        <strong>{dateText(props.graceUntil)}</strong> your account moves to the Free plan.
      </P>
      <P>
        On Free you keep every board, but only your {String(PLAN_LIMITS.free.boards)} most recently
        edited ones stay editable.
      </P>
    </Layout>,
  );
}

export interface DowngradedProps {
  previousPlan: Plan;
  lockedBoards: number;
  pricingUrl: string;
}

export function downgradedEmail(to: string, props: DowngradedProps): Promise<EmailMessage> {
  return message(
    to,
    "Your Whiteboard.ai account is now on the Free plan",
    <Layout
      preview="Nothing was deleted. Upgrade any time to unlock your boards."
      heading="You're on the Free plan now"
      action={{ label: "See plans", href: props.pricingUrl }}
    >
      <P>Your {PLAN_NAMES[props.previousPlan]} plan has ended. Nothing was deleted.</P>
      {props.lockedBoards > 0 ? (
        <P>
          {String(props.lockedBoards)} {props.lockedBoards === 1 ? "board is" : "boards are"} now
          read-only because Free includes {String(PLAN_LIMITS.free.boards)} boards. Upgrade, or move
          boards you no longer need to the trash, to edit them again.
        </P>
      ) : null}
    </Layout>,
  );
}
