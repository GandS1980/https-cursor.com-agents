import { v4 as uuid } from "uuid";
import { Appointment, AppointmentStatus } from "../types";
import { SalesStore } from "../store";
import { OpenClawClient } from "../openclaw-client";

const SCHEDULING_PROMPT = `You are an expert scheduling assistant for a sales team.
Given prospect details and available time slots, suggest the best meeting time
and generate a professional meeting invitation message.
Return JSON with:
- "suggestedSlot": ISO 8601 datetime string for the proposed meeting
- "durationMinutes": number (default 30)
- "inviteMessage": professional meeting invite text
- "title": short meeting title
Respond ONLY with valid JSON.`;

export interface ScheduleRequest {
  leadId: string;
  preferredTimes?: string[]; // ISO datetime strings
  durationMinutes?: number;
  topic?: string;
}

export class AppointmentSchedulerModule {
  constructor(
    private store: SalesStore,
    private ai: OpenClawClient
  ) {}

  /**
   * Schedule an appointment for a lead using AI to craft the invite.
   */
  async scheduleAppointment(request: ScheduleRequest): Promise<Appointment> {
    const lead = this.store.getLead(request.leadId);
    if (!lead) throw new Error(`Lead ${request.leadId} not found`);

    const aiResponse = await this.ai.prompt(
      SCHEDULING_PROMPT,
      JSON.stringify({
        lead: { name: lead.name, company: lead.company, email: lead.email },
        preferredTimes: request.preferredTimes ?? [],
        topic: request.topic ?? "Introductory Sales Call",
        durationMinutes: request.durationMinutes ?? 30,
      })
    );

    let parsed: {
      suggestedSlot: string;
      durationMinutes: number;
      inviteMessage: string;
      title: string;
    };

    const fallback = () => {
      const fallbackTime =
        request.preferredTimes?.[0] ??
        new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      return {
        suggestedSlot: fallbackTime,
        durationMinutes: request.durationMinutes ?? 30,
        inviteMessage: `Hi ${lead.name}, I'd love to set up a call to discuss how we can help ${lead.company}. Does this time work for you?`,
        title: `Sales Call — ${lead.company}`,
      };
    };

    try {
      parsed = JSON.parse(aiResponse);
      // The AI can return valid JSON with a missing or malformed datetime;
      // an unchecked one becomes an Invalid Date that breaks every consumer.
      if (isNaN(new Date(parsed.suggestedSlot).getTime())) {
        parsed = fallback();
      }
    } catch {
      parsed = fallback();
    }

    const appointment: Appointment = {
      id: uuid(),
      leadId: lead.id,
      title: parsed.title,
      description: parsed.inviteMessage,
      scheduledAt: new Date(parsed.suggestedSlot),
      durationMinutes: parsed.durationMinutes,
      status: "scheduled",
      createdAt: new Date(),
    };

    this.store.saveAppointment(appointment);

    // Update lead status
    lead.status = "appointment_set";
    lead.updatedAt = new Date();
    this.store.saveLead(lead);

    return appointment;
  }

  /**
   * Update appointment status (confirm, cancel, etc.)
   */
  updateStatus(appointmentId: string, status: AppointmentStatus): Appointment {
    const appt = this.store.getAppointment(appointmentId);
    if (!appt) throw new Error(`Appointment ${appointmentId} not found`);

    appt.status = status;
    this.store.saveAppointment(appt);
    return appt;
  }

  /**
   * Get all upcoming appointments sorted chronologically.
   */
  getUpcoming(): Appointment[] {
    return this.store.getUpcomingAppointments();
  }

  /**
   * Generate a pre-meeting brief for the sales rep.
   */
  async generateMeetingBrief(appointmentId: string): Promise<string> {
    const appt = this.store.getAppointment(appointmentId);
    if (!appt) throw new Error(`Appointment ${appointmentId} not found`);

    const lead = this.store.getLead(appt.leadId);
    if (!lead) throw new Error(`Lead ${appt.leadId} not found`);

    const previousCalls = this.store.getCallsForLead(lead.id);

    return this.ai.prompt(
      `You are a sales coach. Prepare a concise pre-meeting brief for a sales rep.
Include: key talking points, potential objections, recommended approach, and questions to ask.
Keep it under 300 words.`,
      JSON.stringify({
        lead: {
          name: lead.name,
          company: lead.company,
          score: lead.score,
          notes: lead.notes,
          metadata: lead.metadata,
        },
        appointment: {
          title: appt.title,
          scheduledAt: appt.scheduledAt,
        },
        previousCalls: previousCalls.map((c) => ({
          outcome: c.outcome,
          summary: c.summary,
          objections: c.objections,
        })),
      })
    );
  }
}
