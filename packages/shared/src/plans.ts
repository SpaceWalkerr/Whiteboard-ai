/**
 * Kept for existing imports: plans and their limits now live in `entitlements/` (one place
 * for every entitlement decision, used by the REST API, the sync server and the web app).
 */
export { PLANS, PLAN_LIMITS, PLAN_NAMES, type Plan, type PlanLimits } from "./entitlements/limits";
