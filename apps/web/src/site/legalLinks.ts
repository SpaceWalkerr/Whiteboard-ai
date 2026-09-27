/** Legal pages Razorpay checks for; every one must stay linked from the footer. */
export const LEGAL_LINKS = [
  { to: "/terms", label: "Terms of Service" },
  { to: "/privacy", label: "Privacy Policy" },
  { to: "/refund-policy", label: "Refund & Cancellation" },
  { to: "/shipping-policy", label: "Shipping & Delivery" },
  { to: "/contact", label: "Contact us" },
] as const;
