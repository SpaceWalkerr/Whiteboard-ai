import { useQuery } from "@tanstack/react-query";
import { aiQuotaSchema } from "@whiteboard/shared/api";
import { useAuth } from "@/auth/authContext";

export const AI_QUOTA_KEY = ["ai-quota"] as const;

/** The signed-in user's plan and AI review allowance (refetched after each review). */
export function useAiQuota(enabled = true) {
  const { api } = useAuth();
  return useQuery({
    queryKey: AI_QUOTA_KEY,
    queryFn: () => api.request("/me/ai-quota", { schema: aiQuotaSchema }),
    enabled,
    staleTime: 30_000,
  });
}
