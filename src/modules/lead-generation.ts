import { v4 as uuid } from "uuid";
import { Lead, LeadStatus } from "../types";
import { SalesStore } from "../store";
import { OpenClawClient } from "../openclaw-client";

const LEAD_QUALIFIER_PROMPT = `You are an expert sales qualification AI.
Given information about a prospect, return a JSON object with:
- "score": number 0-100 indicating how qualified the lead is
- "status": one of "new", "qualified", or "contacted"
- "notes": array of strings with key observations
- "suggestedOutreach": a short personalised outreach message

Evaluate based on: company size, industry fit, budget indicators, decision-making authority, timeline urgency, and pain-point alignment.
Respond ONLY with valid JSON.`;

export interface ProspectInput {
  name: string;
  company: string;
  email: string;
  phone?: string;
  source: string;
  context?: string; // any extra info about the prospect
}

export class LeadGenerationModule {
  constructor(
    private store: SalesStore,
    private ai: OpenClawClient
  ) {}

  /**
   * Ingest a new prospect, score them with AI, and store as a lead.
   */
  async ingestProspect(input: ProspectInput): Promise<Lead> {
    const qualificationResponse = await this.ai.prompt(
      LEAD_QUALIFIER_PROMPT,
      JSON.stringify(input)
    );

    let parsed: {
      score: number;
      status: LeadStatus;
      notes: string[];
      suggestedOutreach?: string;
    };

    try {
      parsed = JSON.parse(qualificationResponse);
    } catch {
      parsed = { score: 50, status: "new", notes: ["Auto-scored — AI parse failed"] };
    }

    const now = new Date();
    const lead: Lead = {
      id: uuid(),
      name: input.name,
      company: input.company,
      email: input.email,
      phone: input.phone,
      source: input.source,
      status: parsed.status,
      score: parsed.score,
      notes: parsed.notes,
      createdAt: now,
      updatedAt: now,
      metadata: {
        suggestedOutreach: parsed.suggestedOutreach ?? null,
        context: input.context ?? null,
      },
    };

    this.store.saveLead(lead);
    return lead;
  }

  /**
   * Bulk-ingest a list of prospects.
   */
  async ingestBatch(prospects: ProspectInput[]): Promise<Lead[]> {
    return Promise.all(prospects.map((p) => this.ingestProspect(p)));
  }

  /**
   * Re-score an existing lead with fresh context.
   */
  async rescoreLead(leadId: string, additionalContext?: string): Promise<Lead> {
    const lead = this.store.getLead(leadId);
    if (!lead) throw new Error(`Lead ${leadId} not found`);

    const payload = {
      ...lead,
      additionalContext,
    };

    const response = await this.ai.prompt(LEAD_QUALIFIER_PROMPT, JSON.stringify(payload));

    let parsed: { score: number; status: LeadStatus; notes: string[] };
    try {
      parsed = JSON.parse(response);
    } catch {
      parsed = { score: lead.score, status: lead.status, notes: lead.notes };
    }

    lead.score = parsed.score;
    lead.status = parsed.status;
    lead.notes = [...lead.notes, ...parsed.notes];
    lead.updatedAt = new Date();
    this.store.saveLead(lead);

    return lead;
  }

  /**
   * Return all leads that meet or exceed the score threshold.
   */
  getQualifiedLeads(threshold: number): Lead[] {
    return this.store.getAllLeads().filter((l) => l.score >= threshold);
  }

  /**
   * Use AI to generate an outreach message for a lead.
   */
  async generateOutreach(leadId: string): Promise<string> {
    const lead = this.store.getLead(leadId);
    if (!lead) throw new Error(`Lead ${leadId} not found`);

    return this.ai.prompt(
      `You are a professional sales development representative.
Write a brief, personalised cold outreach email for this prospect.
Be warm, specific to their company, and end with a clear CTA to book a call.
Keep it under 150 words.`,
      JSON.stringify({
        name: lead.name,
        company: lead.company,
        source: lead.source,
        notes: lead.notes,
        metadata: lead.metadata,
      })
    );
  }
}
