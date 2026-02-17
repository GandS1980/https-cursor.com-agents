// ── Lead ────────────────────────────────────────────────────────────────────

export type LeadStatus =
  | "new"
  | "contacted"
  | "qualified"
  | "appointment_set"
  | "in_conversation"
  | "proposal_sent"
  | "won"
  | "lost";

export interface Lead {
  id: string;
  name: string;
  company: string;
  email: string;
  phone?: string;
  source: string;
  status: LeadStatus;
  score: number; // 0-100
  notes: string[];
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
}

// ── Appointment ─────────────────────────────────────────────────────────────

export type AppointmentStatus =
  | "scheduled"
  | "confirmed"
  | "completed"
  | "cancelled"
  | "no_show";

export interface Appointment {
  id: string;
  leadId: string;
  title: string;
  description: string;
  scheduledAt: Date;
  durationMinutes: number;
  status: AppointmentStatus;
  meetingLink?: string;
  createdAt: Date;
}

// ── Sales Call ──────────────────────────────────────────────────────────────

export type CallOutcome =
  | "interested"
  | "follow_up"
  | "objection"
  | "closed_won"
  | "closed_lost"
  | "no_answer"
  | "voicemail";

export interface SalesCall {
  id: string;
  leadId: string;
  appointmentId?: string;
  startedAt: Date;
  endedAt?: Date;
  outcome: CallOutcome;
  summary: string;
  nextSteps: string[];
  objections: string[];
  transcript?: string;
}

// ── Deal ────────────────────────────────────────────────────────────────────

export type DealStage =
  | "discovery"
  | "qualification"
  | "proposal"
  | "negotiation"
  | "closed_won"
  | "closed_lost";

export interface Deal {
  id: string;
  leadId: string;
  title: string;
  value: number;
  currency: string;
  stage: DealStage;
  probability: number; // 0-100
  expectedCloseDate: Date;
  calls: string[]; // call IDs
  createdAt: Date;
  updatedAt: Date;
}

// ── Pipeline Metrics ────────────────────────────────────────────────────────

export interface PipelineMetrics {
  totalLeads: number;
  qualifiedLeads: number;
  appointmentsSet: number;
  callsMade: number;
  dealsInPipeline: number;
  totalPipelineValue: number;
  wonDeals: number;
  wonRevenue: number;
  conversionRate: number;
}

// ── OpenClaw Integration ────────────────────────────────────────────────────

export interface OpenClawConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface OpenClawMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenClawResponse {
  content: string;
  usage?: { promptTokens: number; completionTokens: number };
}

// ── Sales Wrapper Config ────────────────────────────────────────────────────

export interface SalesWrapperConfig {
  openclaw: OpenClawConfig;
  leadScoreThreshold: number;
  autoFollowUp: boolean;
  maxCallAttempts: number;
  followUpIntervalHours: number;
  workingHoursStart: number; // 0-23
  workingHoursEnd: number;   // 0-23
  timezone: string;
}
