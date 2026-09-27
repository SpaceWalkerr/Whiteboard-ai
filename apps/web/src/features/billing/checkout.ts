import type { BillingSummary, CheckoutRequest, CheckoutResponse } from "@whiteboard/shared/billing";
import type { BillingApi } from "./api";

/**
 * Razorpay Checkout (card/UPI entry happens on Razorpay's side, never in our page). The
 * script is loaded only when someone starts paying. The browser's "success" callback is not
 * trusted for anything: we then ask our server to fetch the subscription from Razorpay.
 */
const SCRIPT_URL = "https://checkout.razorpay.com/v1/checkout.js";

interface RazorpayInstance {
  open(): void;
  on(event: "payment.failed", handler: (response: unknown) => void): void;
}
type RazorpayConstructor = new (options: Record<string, unknown>) => RazorpayInstance;

let scriptPromise: Promise<RazorpayConstructor> | null = null;

function loadRazorpay(): Promise<RazorpayConstructor> {
  const existing = (window as { Razorpay?: RazorpayConstructor }).Razorpay;
  if (existing) return Promise.resolve(existing);
  scriptPromise ??= new Promise<RazorpayConstructor>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => {
      const loaded = (window as { Razorpay?: RazorpayConstructor }).Razorpay;
      if (loaded) resolve(loaded);
      else reject(new Error("Razorpay didn't load"));
    };
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error("Couldn't load the payment page. Check your connection and try again."));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export type CheckoutOutcome = "paid" | "dismissed";

/** Opens Razorpay's checkout for a subscription the server created. */
export async function openRazorpay(checkout: CheckoutResponse): Promise<CheckoutOutcome> {
  const Razorpay = await loadRazorpay();
  return new Promise<CheckoutOutcome>((resolve) => {
    const instance = new Razorpay({
      key: checkout.razorpay.keyId,
      subscription_id: checkout.razorpay.subscriptionId,
      name: "Whiteboard.ai",
      description: checkout.description,
      prefill: {
        ...(checkout.prefill.email ? { email: checkout.prefill.email } : {}),
        ...(checkout.prefill.name ? { name: checkout.prefill.name } : {}),
      },
      theme: { color: "#111827" },
      handler: () => {
        resolve("paid");
      },
      modal: {
        ondismiss: () => {
          resolve("dismissed");
        },
      },
    });
    instance.open();
  });
}

/**
 * Checkout end to end: server creates the subscription → Razorpay collects the payment →
 * the server fetches the result from Razorpay (a few tries: activation can lag a moment).
 */
export async function runCheckout(
  billing: BillingApi,
  request: CheckoutRequest,
  open: (checkout: CheckoutResponse) => Promise<CheckoutOutcome> = openRazorpay,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<{ outcome: CheckoutOutcome; summary: BillingSummary | null }> {
  const checkout = await billing.checkout(request);
  const outcome = await open(checkout);
  if (outcome === "dismissed") return { outcome, summary: null };
  let summary: BillingSummary | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    summary = await billing.refresh();
    if (
      summary.subscriptions.some((s) => s.id === checkout.subscriptionId && s.status !== "created")
    )
      break;
    await wait(1500 * (attempt + 1));
  }
  return { outcome, summary };
}
