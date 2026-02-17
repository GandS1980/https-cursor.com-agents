import { v4 as uuid } from "uuid";
import { Deal, DealStage, PipelineMetrics } from "../types";
import { SalesStore } from "../store";
import { OpenClawClient } from "../openclaw-client";

const PROPOSAL_PROMPT = `You are a senior sales strategist.
Given deal context, generate a professional proposal outline in JSON:
- "executiveSummary": 2-3 sentence overview
- "valueProposition": array of bullet points
- "pricingTier": "starter" | "professional" | "enterprise"
- "suggestedPrice": number
- "terms": key terms and conditions as array
- "closingArgument": compelling reason to sign now
Respond ONLY with valid JSON.`;

const DEAL_ADVISOR_PROMPT = `You are an expert sales coach.
Given a deal's current state and history, provide strategic advice in JSON:
- "riskLevel": "low" | "medium" | "high"
- "probability": number 0-100
- "advice": array of actionable recommendations
- "suggestedNextStage": next deal stage to aim for
- "blockers": potential blockers to closing
Respond ONLY with valid JSON.`;

export class DealPipelineModule {
  constructor(
    private store: SalesStore,
    private ai: OpenClawClient
  ) {}

  /**
   * Create a new deal for a qualified lead.
   */
  createDeal(
    leadId: string,
    title: string,
    estimatedValue: number,
    currency = "USD"
  ): Deal {
    const lead = this.store.getLead(leadId);
    if (!lead) throw new Error(`Lead ${leadId} not found`);

    const deal: Deal = {
      id: uuid(),
      leadId,
      title,
      value: estimatedValue,
      currency,
      stage: "discovery",
      probability: 10,
      expectedCloseDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days out
      calls: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.store.saveDeal(deal);
    return deal;
  }

  /**
   * Advance a deal to the next stage.
   */
  advanceStage(dealId: string, newStage: DealStage): Deal {
    const deal = this.store.getDeal(dealId);
    if (!deal) throw new Error(`Deal ${dealId} not found`);

    const stageProbabilities: Record<DealStage, number> = {
      discovery: 10,
      qualification: 25,
      proposal: 50,
      negotiation: 75,
      closed_won: 100,
      closed_lost: 0,
    };

    deal.stage = newStage;
    deal.probability = stageProbabilities[newStage];
    deal.updatedAt = new Date();
    this.store.saveDeal(deal);

    // Update lead status when deal closes
    const lead = this.store.getLead(deal.leadId);
    if (lead) {
      if (newStage === "closed_won") lead.status = "won";
      else if (newStage === "closed_lost") lead.status = "lost";
      else if (newStage === "proposal") lead.status = "proposal_sent";
      lead.updatedAt = new Date();
      this.store.saveLead(lead);
    }

    return deal;
  }

  /**
   * Link a completed sales call to a deal.
   */
  linkCall(dealId: string, callId: string): Deal {
    const deal = this.store.getDeal(dealId);
    if (!deal) throw new Error(`Deal ${dealId} not found`);

    deal.calls.push(callId);
    deal.updatedAt = new Date();
    this.store.saveDeal(deal);
    return deal;
  }

  /**
   * AI-generated proposal for a deal.
   */
  async generateProposal(dealId: string): Promise<string> {
    const deal = this.store.getDeal(dealId);
    if (!deal) throw new Error(`Deal ${dealId} not found`);

    const lead = this.store.getLead(deal.leadId);
    if (!lead) throw new Error(`Lead ${deal.leadId} not found`);

    const calls = deal.calls
      .map((cid) => this.store.getCall(cid))
      .filter(Boolean);

    const response = await this.ai.prompt(
      PROPOSAL_PROMPT,
      JSON.stringify({
        deal: {
          title: deal.title,
          value: deal.value,
          currency: deal.currency,
          stage: deal.stage,
        },
        prospect: {
          name: lead.name,
          company: lead.company,
          notes: lead.notes,
          score: lead.score,
        },
        callHistory: calls.map((c) => ({
          summary: c!.summary,
          outcome: c!.outcome,
          objections: c!.objections,
        })),
      })
    );

    return response;
  }

  /**
   * Get strategic AI advice for progressing a deal.
   */
  async getDealAdvice(dealId: string): Promise<string> {
    const deal = this.store.getDeal(dealId);
    if (!deal) throw new Error(`Deal ${dealId} not found`);

    const lead = this.store.getLead(deal.leadId);
    const calls = deal.calls
      .map((cid) => this.store.getCall(cid))
      .filter(Boolean);

    const response = await this.ai.prompt(
      DEAL_ADVISOR_PROMPT,
      JSON.stringify({
        deal,
        lead,
        callHistory: calls.map((c) => ({
          summary: c!.summary,
          outcome: c!.outcome,
          nextSteps: c!.nextSteps,
          objections: c!.objections,
        })),
      })
    );

    return response;
  }

  /**
   * Compute aggregate pipeline metrics.
   */
  getMetrics(): PipelineMetrics {
    const leads = this.store.getAllLeads();
    const deals = this.store.getAllDeals();

    const wonDeals = deals.filter((d) => d.stage === "closed_won");
    const activeDeals = deals.filter(
      (d) => d.stage !== "closed_won" && d.stage !== "closed_lost"
    );

    return {
      totalLeads: leads.length,
      qualifiedLeads: leads.filter((l) => l.status === "qualified" || l.score >= 60).length,
      appointmentsSet: leads.filter((l) => l.status === "appointment_set").length,
      callsMade: leads.filter(
        (l) => l.status === "in_conversation" || l.status === "won" || l.status === "lost"
      ).length,
      dealsInPipeline: activeDeals.length,
      totalPipelineValue: activeDeals.reduce((sum, d) => sum + d.value * (d.probability / 100), 0),
      wonDeals: wonDeals.length,
      wonRevenue: wonDeals.reduce((sum, d) => sum + d.value, 0),
      conversionRate:
        leads.length > 0
          ? Math.round((wonDeals.length / leads.length) * 100)
          : 0,
    };
  }
}
