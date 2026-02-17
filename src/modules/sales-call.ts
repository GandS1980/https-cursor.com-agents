import { v4 as uuid } from "uuid";
import { SalesCall, CallOutcome } from "../types";
import { SalesStore } from "../store";
import { OpenClawClient } from "../openclaw-client";

const CALL_CONDUCTOR_PROMPT = `You are an elite AI sales agent conducting a live sales conversation.
Your goals:
1. Build rapport quickly
2. Identify pain points through open-ended questions
3. Present value propositions that map to their specific needs
4. Handle objections with empathy and evidence
5. Guide toward a clear next step (demo, proposal, or close)

Respond with your next message in the conversation. Be natural, concise, and persuasive.
Never be pushy — focus on understanding and helping.`;

const CALL_ANALYZER_PROMPT = `You are a sales call analyst. Given a conversation transcript, return JSON with:
- "outcome": one of "interested", "follow_up", "objection", "closed_won", "closed_lost"
- "summary": 2-3 sentence summary of the call
- "nextSteps": array of recommended next actions
- "objections": array of objections raised by the prospect
- "sentiment": "positive", "neutral", or "negative"
- "buyingSignals": array of any buying signals detected
Respond ONLY with valid JSON.`;

export interface CallMessage {
  role: "agent" | "prospect";
  content: string;
  timestamp: Date;
}

export class SalesCallModule {
  constructor(
    private store: SalesStore,
    private ai: OpenClawClient
  ) {}

  /**
   * Start a new sales call session.
   */
  startCall(leadId: string, appointmentId?: string): SalesCall {
    const lead = this.store.getLead(leadId);
    if (!lead) throw new Error(`Lead ${leadId} not found`);

    const call: SalesCall = {
      id: uuid(),
      leadId,
      appointmentId,
      startedAt: new Date(),
      outcome: "follow_up",
      summary: "",
      nextSteps: [],
      objections: [],
      transcript: "",
    };

    this.store.saveCall(call);

    // Update lead status
    lead.status = "in_conversation";
    lead.updatedAt = new Date();
    this.store.saveLead(lead);

    return call;
  }

  /**
   * Generate the agent's next response during a live call.
   * Pass the conversation history so far.
   */
  async generateResponse(
    callId: string,
    conversationHistory: CallMessage[]
  ): Promise<string> {
    const call = this.store.getCall(callId);
    if (!call) throw new Error(`Call ${callId} not found`);

    const lead = this.store.getLead(call.leadId);
    if (!lead) throw new Error(`Lead ${call.leadId} not found`);

    const previousCalls = this.store.getCallsForLead(lead.id).filter(
      (c) => c.id !== callId
    );

    const systemContext = `${CALL_CONDUCTOR_PROMPT}

Prospect info:
- Name: ${lead.name}
- Company: ${lead.company}
- Lead score: ${lead.score}/100
- Previous notes: ${lead.notes.join("; ")}
${previousCalls.length > 0 ? `- Previous call outcomes: ${previousCalls.map((c) => c.outcome).join(", ")}` : ""}
${previousCalls.length > 0 ? `- Previous objections: ${previousCalls.flatMap((c) => c.objections).join("; ")}` : ""}`;

    const messages = conversationHistory.map((m) => ({
      role: m.role === "agent" ? ("assistant" as const) : ("user" as const),
      content: m.content,
    }));

    const response = await this.ai.chat([
      { role: "system", content: systemContext },
      ...messages,
    ]);

    // Append to transcript
    const newLine = `[Agent]: ${response.content}\n`;
    call.transcript = (call.transcript ?? "") + newLine;
    this.store.saveCall(call);

    return response.content;
  }

  /**
   * Record a prospect message into the call transcript.
   */
  recordProspectMessage(callId: string, message: string): void {
    const call = this.store.getCall(callId);
    if (!call) throw new Error(`Call ${callId} not found`);

    call.transcript = (call.transcript ?? "") + `[Prospect]: ${message}\n`;
    this.store.saveCall(call);
  }

  /**
   * End a call and analyze the outcome using AI.
   */
  async endCall(callId: string): Promise<SalesCall> {
    const call = this.store.getCall(callId);
    if (!call) throw new Error(`Call ${callId} not found`);

    call.endedAt = new Date();

    const analysisResponse = await this.ai.prompt(
      CALL_ANALYZER_PROMPT,
      call.transcript ?? "No transcript available"
    );

    let analysis: {
      outcome: CallOutcome;
      summary: string;
      nextSteps: string[];
      objections: string[];
    };

    try {
      analysis = JSON.parse(analysisResponse);
    } catch {
      analysis = {
        outcome: "follow_up",
        summary: "Call completed — manual review needed",
        nextSteps: ["Review call and determine next steps"],
        objections: [],
      };
    }

    call.outcome = analysis.outcome;
    call.summary = analysis.summary;
    call.nextSteps = analysis.nextSteps;
    call.objections = analysis.objections;
    this.store.saveCall(call);

    // Update lead based on call outcome
    const lead = this.store.getLead(call.leadId);
    if (lead) {
      if (call.outcome === "closed_won") {
        lead.status = "won";
      } else if (call.outcome === "closed_lost") {
        lead.status = "lost";
      }
      lead.notes.push(`Call ${callId}: ${call.summary}`);
      lead.updatedAt = new Date();
      this.store.saveLead(lead);
    }

    return call;
  }

  /**
   * Generate a follow-up message after a call.
   */
  async generateFollowUp(callId: string): Promise<string> {
    const call = this.store.getCall(callId);
    if (!call) throw new Error(`Call ${callId} not found`);

    const lead = this.store.getLead(call.leadId);
    if (!lead) throw new Error(`Lead ${call.leadId} not found`);

    return this.ai.prompt(
      `You are a sales professional writing a follow-up email after a call.
Reference specific points from the conversation. Be concise and include a clear next step.
Keep it under 150 words.`,
      JSON.stringify({
        prospect: { name: lead.name, company: lead.company },
        callSummary: call.summary,
        outcome: call.outcome,
        nextSteps: call.nextSteps,
        objections: call.objections,
      })
    );
  }
}
