import { v4 as uuid } from "uuid";
import { Lead, LeadStatus, ProductConfig } from "../types";
import { SalesStore } from "../store";
import { OpenClawClient } from "../openclaw-client";

function leadQualifierPrompt(product: ProductConfig): string {
  return `You are an expert sales qualification AI for ${product.name}.
${product.pitch}

Ideal customer profile:
- Company types: ${product.icp.companyTypes.join("; ")}
- Buyer titles: ${product.icp.buyerTitles.join("; ")}
- Buying signals (score higher when present): ${product.icp.buyingSignals.join("; ")}
- Disqualifiers (score below 30 when present): ${product.icp.disqualifiers.join("; ")}

Given information about a prospect, return a JSON object with:
- "score": number 0-100 indicating how well they fit the profile above
- "status": one of "new", "qualified", or "contacted"
- "notes": array of strings with key observations (call out which ICP signals matched or are missing)
- "suggestedOutreach": a short personalised outreach message

Score primarily on ICP fit, buying signals, and the contact's decision-making authority.
Respond ONLY with valid JSON.`;
}

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
    private ai: OpenClawClient,
    private product: ProductConfig
  ) {}

  /**
   * Ingest a new prospect, score them with AI, and store as a lead.
   */
  async ingestProspect(input: ProspectInput): Promise<Lead> {
    const qualificationResponse = await this.ai.prompt(
      leadQualifierPrompt(this.product),
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

    const response = await this.ai.prompt(
      leadQualifierPrompt(this.product),
      JSON.stringify(payload)
    );

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
      `You are a sales development representative selling ${this.product.name}.
${this.product.pitch}

Write a brief, personalised cold outreach email for this prospect — a recruiting/talent buyer.
Structure it as:
1. Open with something specific to their company or hiring activity (e.g. their open roles), never a generic compliment.
2. Speak to one pain point they most likely feel: ${this.product.painPoints.join("; ")}.
3. One sentence on how ${this.product.name} addresses it — no feature lists.
4. End with this CTA: "${this.product.cta}".
Keep it under 150 words. No subject line hype, no exclamation marks.`,
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
