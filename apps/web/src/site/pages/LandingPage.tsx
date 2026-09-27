import { ArrowRight, MessagesSquare, PenTool, Sparkles, Timer, Users, Wrench } from "lucide-react";
import { Link } from "react-router";
import { PLAN_LIMITS, PLAN_NAMES } from "@whiteboard/shared/entitlements";
import { Button } from "@/components/ui/button";
import { useCatalog } from "@/features/billing/api";
import { PlanCards } from "@/features/billing/PlanCards";
import { DEMO_VIDEO, TESTIMONIALS } from "../config";
import { usePageTitle } from "../layout/usePageTitle";
import { STATIC_PAGES } from "../meta";
import { LANDING_FAQ, LANDING_PREVIEW } from "./landingContent";

const STEPS = [
  {
    icon: PenTool,
    title: "Draw",
    text: "Sketch your architecture with typed shapes — clients, load balancers, services, databases, caches, queues — and arrows that know whether a call is sync, async or replication. Draw together in real time.",
  },
  {
    icon: Sparkles,
    title: "Review",
    text: "Ask for a review. A rules engine and Claude read your diagram as a graph and point out single points of failure, missing caches, deep call chains and more — each finding highlighted on the canvas.",
  },
  {
    icon: Wrench,
    title: "Improve",
    text: "Every finding comes with a concrete fix. Apply it, review again, and watch the design get stronger — the same loop a senior engineer would take you through.",
  },
] as const;

function DemoSlot() {
  if (DEMO_VIDEO) {
    return (
      <video
        className="aspect-video w-full rounded-lg border bg-muted"
        controls
        preload="none"
        poster={DEMO_VIDEO.poster}
        width={1280}
        height={720}
        aria-label="60-second product demo"
      >
        {DEMO_VIDEO.webm && <source src={DEMO_VIDEO.webm} type="video/webm" />}
        <source src={DEMO_VIDEO.mp4} type="video/mp4" />
        <track kind="captions" src={DEMO_VIDEO.captions} srcLang="en" label="English" default />
        <track kind="captions" src={DEMO_VIDEO.captions} srcLang="en" label="English" default />
      </video>
    );
  }
  return (
    <figure className="rounded-lg border bg-white p-3">
      <img
        src={`/template-previews/${LANDING_PREVIEW.slug}.svg`}
        alt="A URL shortener architecture on a Whiteboard.ai board: load balancer, shortener service, cache, replicated database and an analytics stream."
        width={LANDING_PREVIEW.width}
        height={LANDING_PREVIEW.height}
        className="h-auto w-full"
        decoding="async"
      />
      <figcaption className="mt-2 text-center text-sm text-neutral-600">
        A starting board from the{" "}
        <Link to={`/templates/${LANDING_PREVIEW.slug}`} className="underline">
          URL shortener template
        </Link>
        .
      </figcaption>
    </figure>
  );
}

export function LandingPage() {
  usePageTitle(STATIC_PAGES["/"].title);
  const catalog = useCatalog();

  return (
    <>
      <section className="mx-auto max-w-6xl px-4 pt-14 pb-10 sm:px-6 sm:pt-20">
        <div className="max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight text-balance sm:text-5xl">
            Design systems together. Get reviewed like a senior engineer is in the room.
          </h1>
          <p className="mt-5 text-lg text-muted-foreground">
            A real-time collaborative whiteboard for system design. Draw your architecture with your
            team — or alone before an interview — and get an AI design review that points at the
            exact boxes and arrows that need work.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link to="/sign-in">
                Start free <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/templates">Browse system design templates</Link>
            </Button>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            Free plan: {String(PLAN_LIMITS.free.boards)} boards and{" "}
            {String(PLAN_LIMITS.free.aiReviewsPerMonth)} AI reviews a month. No card needed.
          </p>
        </div>
        <div className="mt-12">
          <h2 className="sr-only">Product demo</h2>
          <DemoSlot />
        </div>
      </section>

      <section aria-labelledby="how-heading" className="border-y bg-muted/40">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 id="how-heading" className="text-3xl font-semibold tracking-tight">
            How it works
          </h2>
          <ol className="mt-8 grid gap-6 md:grid-cols-3">
            {STEPS.map((step, i) => (
              <li key={step.title} className="rounded-lg border bg-background p-6">
                <step.icon className="size-6" aria-hidden="true" />
                <h3 className="mt-3 text-lg font-semibold">
                  {String(i + 1)}. {step.title}
                </h3>
                <p className="mt-2 text-muted-foreground">{step.text}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section aria-labelledby="interview-heading" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <div className="grid gap-10 md:grid-cols-2 md:items-center">
          <div>
            <h2 id="interview-heading" className="text-3xl font-semibold tracking-tight">
              Interview mode for hiring teams
            </h2>
            <p className="mt-4 text-muted-foreground">
              Run live system design rounds on the same board your candidate draws on. Pick a
              question from the bank, start the timer, take private notes the candidate never sees,
              and score against a rubric. Afterwards, replay the whole session with a timeline
              scrubber and share a summary with the hiring panel.
            </p>
            <Link
              to="/docs/interview-mode"
              className="mt-4 inline-block font-medium underline underline-offset-4"
            >
              How interview mode works
            </Link>
          </div>
          <ul className="grid gap-3 text-sm">
            {[
              { icon: Users, text: "Interviewer and candidate roles" },
              { icon: Timer, text: "Question bank and countdown timer" },
              { icon: MessagesSquare, text: "Private notes and rubric scorecard" },
              { icon: Sparkles, text: "Full session replay and PDF summary" },
            ].map((item) => (
              <li key={item.text} className="flex items-center gap-3 rounded-lg border p-4">
                <item.icon className="size-5 shrink-0" aria-hidden="true" />
                {item.text}
              </li>
            ))}
            <li className="text-muted-foreground">Included in the {PLAN_NAMES.team} plan.</li>
          </ul>
        </div>
      </section>

      {TESTIMONIALS.length > 0 && (
        <section aria-labelledby="testimonials-heading" className="border-y bg-muted/40">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
            <h2 id="testimonials-heading" className="text-3xl font-semibold tracking-tight">
              What people say
            </h2>
            <ul className="mt-8 grid gap-6 md:grid-cols-3">
              {TESTIMONIALS.map((t) => (
                <li key={t.name}>
                  <figure className="h-full rounded-lg border bg-background p-6">
                    <blockquote className="text-muted-foreground">“{t.quote}”</blockquote>
                    <figcaption className="mt-4 text-sm">
                      <span className="font-medium">{t.name}</span>, {t.role}
                    </figcaption>
                  </figure>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <section aria-labelledby="pricing-heading" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <h2 id="pricing-heading" className="text-3xl font-semibold tracking-tight">
          Simple pricing
        </h2>
        <p className="mt-2 text-muted-foreground">
          Monthly prices in INR, taxes included. Pay yearly and get 2 months free.
        </p>
        <div className="mt-8">
          <PlanCards
            plans={catalog.data?.plans ?? []}
            interval="month"
            action={(tier) => (
              <Button asChild className="w-full" variant={tier === "pro" ? "default" : "outline"}>
                <Link to={tier === "free" ? "/sign-in" : "/pricing"}>
                  {tier === "free" ? "Start free" : `Choose ${PLAN_NAMES[tier]}`}
                </Link>
              </Button>
            )}
          />
        </div>
      </section>

      <section aria-labelledby="faq-heading" className="border-t bg-muted/40">
        <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
          <h2 id="faq-heading" className="text-3xl font-semibold tracking-tight">
            Frequently asked questions
          </h2>
          <div className="mt-8 divide-y rounded-lg border bg-background">
            {LANDING_FAQ.map((item) => (
              <details key={item.question} className="group p-5">
                <summary className="cursor-pointer rounded-sm font-medium">{item.question}</summary>
                <p className="mt-3 text-muted-foreground">{item.answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 pt-16 text-center sm:px-6">
        <h2 className="text-3xl font-semibold tracking-tight">Draw your next design today</h2>
        <p className="mx-auto mt-3 max-w-xl text-muted-foreground">
          Start from a blank board or a classic system design, invite your team, and ask for a
          review when you're ready.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Button asChild size="lg">
            <Link to="/sign-in">Start free</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link to="/pricing">See pricing</Link>
          </Button>
        </div>
      </section>
    </>
  );
}
