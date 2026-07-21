import { SalesWrapperConfig, ProductConfig } from "./types";

export const RECRUITERSTACK_PRODUCT: ProductConfig = {
  name: "RecruiterStack",
  pitch:
    "RecruiterStack helps recruiting teams fill roles faster by automating sourcing, outreach, and pipeline tracking in one place.",
  painPoints: [
    "Time-to-fill keeps climbing while hiring managers demand faster shortlists",
    "Recruiters juggle sourcing, outreach, and tracking across disconnected tools",
    "Candidate outreach is manual and response rates keep dropping",
    "No clear pipeline visibility across open reqs",
  ],
  icp: {
    companyTypes: [
      "Staffing and recruiting agencies",
      "In-house talent acquisition teams at companies actively hiring",
      "RPO (recruitment process outsourcing) providers",
    ],
    buyerTitles: [
      "Head of Talent / Head of Talent Acquisition",
      "Talent Acquisition Manager",
      "Recruiting Operations Lead",
      "Staffing agency owner or managing director",
    ],
    buyingSignals: [
      "Spike in open job postings",
      "Recent funding round (hiring usually follows)",
      "Recently hired a Head of Talent or first recruiter",
      "Job posts open longer than 45 days (slow time-to-fill)",
    ],
    disqualifiers: [
      "Fewer than 3 open roles and no agency business",
      "Hiring freeze or recent layoffs",
      "No dedicated recruiting function and no plans for one",
    ],
  },
  pricing: "From $99 per recruiter seat per month, annual billing",
  competitors: ["LinkedIn Recruiter", "Gem", "SeekOut", "spreadsheets + ATS"],
  objectionHandling: {
    "We already use LinkedIn Recruiter":
      "LinkedIn is a sourcing database; RecruiterStack automates what happens after — outreach sequences, follow-ups, and pipeline tracking. Most customers use both and cut manual work in half.",
    "We already have an ATS":
      "An ATS tracks applicants who arrive; RecruiterStack fills the top of the funnel with outbound sourcing and automated outreach. It syncs into the ATS, not against it.",
    "Too expensive":
      "Anchor on cost-per-hire: one placement made two weeks sooner typically covers a year of seats. Offer the ROI worksheet rather than discounting.",
    "No time to switch tools":
      "Onboarding is under a week and runs alongside existing tools — nothing is ripped out on day one.",
  },
  cta: "Book a 15-minute demo",
};

export const DEFAULT_CONFIG: SalesWrapperConfig = {
  openclaw: {
    baseUrl: process.env.OPENCLAW_BASE_URL || "https://api.openclaw.ai",
    apiKey: process.env.OPENCLAW_API_KEY || "",
    model: process.env.OPENCLAW_MODEL || "openclaw-default",
    temperature: 0.7,
    maxTokens: 2048,
  },
  product: RECRUITERSTACK_PRODUCT,
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
    product: {
      ...DEFAULT_CONFIG.product,
      ...overrides?.product,
    },
  };
}
