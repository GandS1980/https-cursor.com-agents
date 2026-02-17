import { SalesWrapperConfig } from "./types";

export const DEFAULT_CONFIG: SalesWrapperConfig = {
  openclaw: {
    baseUrl: process.env.OPENCLAW_BASE_URL || "https://api.openclaw.ai",
    apiKey: process.env.OPENCLAW_API_KEY || "",
    model: process.env.OPENCLAW_MODEL || "openclaw-default",
    temperature: 0.7,
    maxTokens: 2048,
  },
  leadScoreThreshold: 60,
  autoFollowUp: true,
  maxCallAttempts: 3,
  followUpIntervalHours: 24,
  workingHoursStart: 9,
  workingHoursEnd: 17,
  timezone: "America/New_York",
};

export function loadConfig(
  overrides?: Partial<SalesWrapperConfig>
): SalesWrapperConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    openclaw: {
      ...DEFAULT_CONFIG.openclaw,
      ...overrides?.openclaw,
    },
  };
}
