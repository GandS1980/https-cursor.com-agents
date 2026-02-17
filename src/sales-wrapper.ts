import { SalesWrapperConfig, PipelineMetrics, Lead } from "./types";
import { loadConfig } from "./config";
import { SalesStore } from "./store";
import { OpenClawClient } from "./openclaw-client";
import { LeadGenerationModule, ProspectInput } from "./modules/lead-generation";
import { AppointmentSchedulerModule, ScheduleRequest } from "./modules/appointment-scheduler";
import { SalesCallModule, CallMessage } from "./modules/sales-call";
import { DealPipelineModule } from "./modules/deal-pipeline";

/**
 * SalesWrapper — the top-level orchestrator.
 *
 * Wraps an OpenClaw agent with a full sales pipeline:
 *   prospect → qualify → schedule → call → close
 */
export class SalesWrapper {
  readonly config: SalesWrapperConfig;
  readonly store: SalesStore;
  readonly ai: OpenClawClient;

  readonly leads: LeadGenerationModule;
  readonly appointments: AppointmentSchedulerModule;
  readonly calls: SalesCallModule;
  readonly deals: DealPipelineModule;

  constructor(overrides?: Partial<SalesWrapperConfig>) {
    this.config = loadConfig(overrides);
    this.store = new SalesStore();
    this.ai = new OpenClawClient(this.config.openclaw);

    this.leads = new LeadGenerationModule(this.store, this.ai);
    this.appointments = new AppointmentSchedulerModule(this.store, this.ai);
    this.calls = new SalesCallModule(this.store, this.ai);
    this.deals = new DealPipelineModule(this.store, this.ai);
  }

  // ── End-to-end workflows ────────────────────────────────────────────────

  /**
   * Full inbound workflow: ingest a prospect, score, and if qualified
   * automatically schedule an appointment.
   */
  async processInboundLead(
    prospect: ProspectInput,
    autoSchedule = this.config.autoFollowUp
  ) {
    const lead = await this.leads.ingestProspect(prospect);

    const result: {
      lead: Lead;
      qualified: boolean;
      appointment?: Awaited<ReturnType<AppointmentSchedulerModule["scheduleAppointment"]>>;
      outreach?: string;
    } = {
      lead,
      qualified: lead.score >= this.config.leadScoreThreshold,
    };

    if (result.qualified && autoSchedule) {
      result.appointment = await this.appointments.scheduleAppointment({
        leadId: lead.id,
        topic: `Intro call with ${lead.name} from ${lead.company}`,
      });
    }

    if (result.qualified) {
      result.outreach = await this.leads.generateOutreach(lead.id);
    }

    return result;
  }

  /**
   * Run a full sales call workflow for a lead:
   * start call → conduct conversation turns → end & analyse → create deal if won.
   */
  async conductSalesCall(
    leadId: string,
    conversationTurns: CallMessage[],
    appointmentId?: string,
    dealValue?: number
  ) {
    const call = this.calls.startCall(leadId, appointmentId);

    // Replay conversation turns, generating agent responses for each
    const agentResponses: string[] = [];
    const history: CallMessage[] = [];

    for (const turn of conversationTurns) {
      if (turn.role === "prospect") {
        this.calls.recordProspectMessage(call.id, turn.content);
        history.push(turn);

        const response = await this.calls.generateResponse(call.id, history);
        agentResponses.push(response);
        history.push({ role: "agent", content: response, timestamp: new Date() });
      } else {
        history.push(turn);
      }
    }

    const completedCall = await this.calls.endCall(call.id);
    const followUp = await this.calls.generateFollowUp(call.id);

    const result: {
      call: typeof completedCall;
      agentResponses: string[];
      followUp: string;
      deal?: ReturnType<DealPipelineModule["createDeal"]>;
    } = {
      call: completedCall,
      agentResponses,
      followUp,
    };

    // Auto-create deal if the call went well
    if (
      completedCall.outcome === "interested" ||
      completedCall.outcome === "closed_won"
    ) {
      const lead = this.store.getLead(leadId)!;
      result.deal = this.deals.createDeal(
        leadId,
        `${lead.company} — ${completedCall.summary.slice(0, 50)}`,
        dealValue ?? 0
      );
      this.deals.linkCall(result.deal.id, call.id);

      if (completedCall.outcome === "closed_won") {
        this.deals.advanceStage(result.deal.id, "closed_won");
      }
    }

    return result;
  }

  /**
   * Dashboard: get full pipeline metrics.
   */
  getMetrics(): PipelineMetrics {
    return this.deals.getMetrics();
  }

  /**
   * Quick summary string for logging / CLI output.
   */
  getSummary(): string {
    const m = this.getMetrics();
    return [
      `=== Sales Pipeline Summary ===`,
      `Leads: ${m.totalLeads} total, ${m.qualifiedLeads} qualified`,
      `Appointments set: ${m.appointmentsSet}`,
      `Calls made: ${m.callsMade}`,
      `Active deals: ${m.dealsInPipeline} ($${m.totalPipelineValue.toLocaleString()} weighted)`,
      `Won: ${m.wonDeals} deals ($${m.wonRevenue.toLocaleString()})`,
      `Conversion rate: ${m.conversionRate}%`,
    ].join("\n");
  }
}
