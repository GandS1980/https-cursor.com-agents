import { Lead, Appointment, SalesCall, Deal } from "./types";

/**
 * In-memory store for all sales entities.
 * Swap this out for a real database adapter in production.
 */
export class SalesStore {
  private leads = new Map<string, Lead>();
  private appointments = new Map<string, Appointment>();
  private calls = new Map<string, SalesCall>();
  private deals = new Map<string, Deal>();

  // ── Leads ───────────────────────────────────────────────────────────────

  saveLead(lead: Lead): void {
    this.leads.set(lead.id, lead);
  }

  getLead(id: string): Lead | undefined {
    return this.leads.get(id);
  }

  getAllLeads(): Lead[] {
    return Array.from(this.leads.values());
  }

  getLeadsByStatus(status: Lead["status"]): Lead[] {
    return this.getAllLeads().filter((l) => l.status === status);
  }

  // ── Appointments ────────────────────────────────────────────────────────

  saveAppointment(appt: Appointment): void {
    this.appointments.set(appt.id, appt);
  }

  getAppointment(id: string): Appointment | undefined {
    return this.appointments.get(id);
  }

  getAppointmentsForLead(leadId: string): Appointment[] {
    return Array.from(this.appointments.values()).filter(
      (a) => a.leadId === leadId
    );
  }

  getUpcomingAppointments(): Appointment[] {
    const now = new Date();
    return Array.from(this.appointments.values())
      .filter((a) => a.scheduledAt > now && a.status === "scheduled")
      .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
  }

  // ── Calls ───────────────────────────────────────────────────────────────

  saveCall(call: SalesCall): void {
    this.calls.set(call.id, call);
  }

  getCall(id: string): SalesCall | undefined {
    return this.calls.get(id);
  }

  getCallsForLead(leadId: string): SalesCall[] {
    return Array.from(this.calls.values()).filter(
      (c) => c.leadId === leadId
    );
  }

  // ── Deals ───────────────────────────────────────────────────────────────

  saveDeal(deal: Deal): void {
    this.deals.set(deal.id, deal);
  }

  getDeal(id: string): Deal | undefined {
    return this.deals.get(id);
  }

  getAllDeals(): Deal[] {
    return Array.from(this.deals.values());
  }

  getDealsByStage(stage: Deal["stage"]): Deal[] {
    return this.getAllDeals().filter((d) => d.stage === stage);
  }
}
