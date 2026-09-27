import {
  GRACE_PERIOD_DAYS,
  PLAN_LIMITS,
  STUDENT_TRIAL_MONTHS,
} from "@whiteboard/shared/entitlements";
import { REFUND_WINDOW_DAYS } from "../config";

export interface FaqItem {
  question: string;
  answer: string;
}

/** Landing page FAQ. Also published as FAQPage structured data, so answers are plain text. */
export const LANDING_FAQ: readonly FaqItem[] = [
  {
    question: "What does the AI review actually check?",
    answer:
      "Your diagram is turned into a typed graph of components (services, databases, caches, queues…) and the calls between them. A rules engine first catches the obvious problems, such as a database with no replica or a queue with no dead-letter queue. Claude then reviews the whole design like a senior engineer and returns findings with a severity and a suggested fix, each linked to the shapes it is about.",
  },
  {
    question: "Is it free to try?",
    answer: `Yes. The Free plan includes ${String(PLAN_LIMITS.free.boards)} boards, up to ${String(PLAN_LIMITS.free.editorsPerBoard)} editors per board and ${String(PLAN_LIMITS.free.aiReviewsPerMonth)} AI design reviews a month, with no card needed. Students with a .edu or .ac.in email get Pro free for ${String(STUDENT_TRIAL_MONTHS)} months.`,
  },
  {
    question: "Can I use it for real interviews?",
    answer:
      "Yes. On the Team plan, interview mode gives interviewers and candidates separate roles, a question bank, a countdown timer, private interviewer notes, a rubric scorecard and a full replay of the session.",
  },
  {
    question: "Who can see my boards?",
    answer:
      "Only people you share them with. Private rooms (Pro and Team) are end-to-end encrypted: the key stays in your link, and our servers store only encrypted data they cannot read.",
  },
  {
    question: "Can I cancel any time?",
    answer: `Yes. Cancel from billing settings and your plan stays active until the end of the period you paid for. If a payment fails you keep your plan for ${String(GRACE_PERIOD_DAYS)} days while you fix it, and your boards are never deleted when you downgrade. A first payment on a plan can be refunded in full within ${String(REFUND_WINDOW_DAYS)} days.`,
  },
  {
    question: "Does it work with other people at the same time?",
    answer:
      "Yes. Everyone on a board sees each other's cursors and edits live, and you can keep editing offline — your changes merge when you reconnect.",
  },
];

/**
 * The template shown in the landing page's demo slot until there is a video. Its size is the
 * template's preview frame (a test keeps them equal), so the image reserves its space.
 */
export const LANDING_PREVIEW = { slug: "url-shortener", width: 1456, height: 702 } as const;
