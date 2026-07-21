import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { SalesWrapper } from "../sales-wrapper";
import { ProspectInput } from "./lead-generation";

/**
 * A row pushed from a Clay table via its HTTP API / webhook column.
 * Clay tables have arbitrary columns, so this is a loose shape: well-known
 * keys are mapped explicitly and every other scalar column is folded into
 * the prospect's context so the AI qualifier can score on it.
 */
export type ClayRow = Record<string, unknown>;

export interface ClayIntakeResult {
  action: "created" | "rescored" | "rejected";
  leadId?: string;
  score?: number;
  qualified?: boolean;
  appointmentAt?: string;
  error?: string;
}

// Key variants Clay tables commonly use for the identity fields.
const NAME_KEYS = ["full_name", "fullName", "name", "contact_name"];
const FIRST_NAME_KEYS = ["first_name", "firstName"];
const LAST_NAME_KEYS = ["last_name", "lastName"];
const COMPANY_KEYS = ["company_name", "companyName", "company", "organization", "company_domain"];
const EMAIL_KEYS = ["email", "work_email", "workEmail", "contact_email", "email_address"];
const PHONE_KEYS = ["phone", "phone_number", "phoneNumber", "mobile", "mobile_phone"];
const SIGNAL_KEYS = ["signal", "buying_signal", "trigger", "intent_signal"];

const IDENTITY_KEYS = new Set([
  ...NAME_KEYS,
  ...FIRST_NAME_KEYS,
  ...LAST_NAME_KEYS,
  ...COMPANY_KEYS,
  ...EMAIL_KEYS,
  ...PHONE_KEYS,
]);

function pickString(row: ClayRow, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

/**
 * Map a Clay row to a ProspectInput. Enrichment columns (open job counts,
 * funding, headcount, tech stack, ...) become context lines for the AI
 * qualifier — that's what lets scoring run on firmographics instead of
 * just name/company/email.
 */
export function mapClayRow(row: ClayRow): ProspectInput {
  const first = pickString(row, FIRST_NAME_KEYS);
  const last = pickString(row, LAST_NAME_KEYS);
  const name =
    pickString(row, NAME_KEYS) ?? [first, last].filter(Boolean).join(" ");
  const company = pickString(row, COMPANY_KEYS) ?? "";
  const email = pickString(row, EMAIL_KEYS) ?? "";

  if (!name) throw new Error("Clay row is missing a contact name");
  if (!company) throw new Error("Clay row is missing a company");
  if (!email) throw new Error("Clay row is missing an email");

  const signal = pickString(row, SIGNAL_KEYS);

  // Fold every remaining scalar column into context for the qualifier.
  const contextLines: string[] = [];
  for (const [key, value] of Object.entries(row)) {
    if (IDENTITY_KEYS.has(key)) continue;
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "object") {
      contextLines.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      contextLines.push(`${key}: ${String(value)}`);
    }
  }

  return {
    name,
    company,
    email,
    phone: pickString(row, PHONE_KEYS),
    source: signal ? `clay:${signal}` : "clay",
    context: contextLines.join("\n") || undefined,
  };
}

/**
 * ClayIntakeModule — accepts rows pushed from Clay and routes them into
 * the pipeline: new contacts run the full inbound workflow (score →
 * auto-schedule → outreach), while contacts we already track get
 * re-scored with the fresh signal as additional context.
 */
export class ClayIntakeModule {
  constructor(private wrapper: SalesWrapper) {}

  async ingestRow(row: ClayRow): Promise<ClayIntakeResult> {
    let prospect: ProspectInput;
    try {
      prospect = mapClayRow(row);
    } catch (err) {
      return { action: "rejected", error: (err as Error).message };
    }

    try {
      const existing = this.wrapper.store.getLeadByEmail(prospect.email);
      if (existing) {
        const freshSignal = [
          `New signal from Clay (source: ${prospect.source})`,
          prospect.context,
        ]
          .filter(Boolean)
          .join("\n");
        const lead = await this.wrapper.leads.rescoreLead(existing.id, freshSignal);
        return {
          action: "rescored",
          leadId: lead.id,
          score: lead.score,
          qualified: lead.score >= this.wrapper.config.leadScoreThreshold,
        };
      }

      const result = await this.wrapper.processInboundLead(prospect);
      const scheduledAt = result.appointment?.scheduledAt;
      return {
        action: "created",
        leadId: result.lead.id,
        score: result.lead.score,
        qualified: result.qualified,
        appointmentAt:
          scheduledAt && !isNaN(scheduledAt.getTime())
            ? scheduledAt.toISOString()
            : undefined,
      };
    } catch (err) {
      // One bad row must not fail the rest of the batch.
      return { action: "rejected", error: (err as Error).message };
    }
  }

  /** Rows are processed sequentially: each one fans out into AI calls. */
  async ingestRows(rows: ClayRow[]): Promise<ClayIntakeResult[]> {
    const results: ClayIntakeResult[] = [];
    for (const row of rows) {
      results.push(await this.ingestRow(row));
    }
    return results;
  }
}

export interface ClayIntakeServerOptions {
  port?: number;
  /**
   * Shared secret Clay must send in the `x-clay-webhook-secret` header.
   * Defaults to CLAY_WEBHOOK_SECRET; if neither is set, auth is disabled
   * (fine for local testing, not for a public endpoint).
   */
  secret?: string;
  /** Path the webhook listens on. */
  path?: string;
}

/**
 * Minimal HTTP endpoint for a Clay table's HTTP API / webhook column.
 * POST a single row, an array of rows, or `{ "rows": [...] }`.
 */
export function createClayIntakeServer(
  wrapper: SalesWrapper,
  options: ClayIntakeServerOptions = {}
): Server {
  const intake = new ClayIntakeModule(wrapper);
  const secret = options.secret ?? process.env.CLAY_WEBHOOK_SECRET;
  const path = options.path ?? "/clay/leads";

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const respond = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.method !== "POST" || (req.url ?? "/") !== path) {
      respond(404, { error: `POST ${path} is the only endpoint` });
      return;
    }
    if (secret && req.headers["x-clay-webhook-secret"] !== secret) {
      respond(401, { error: "invalid or missing x-clay-webhook-secret header" });
      return;
    }

    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw || "{}");
      } catch {
        respond(400, { error: "request body is not valid JSON" });
        return;
      }

      const rows: ClayRow[] = Array.isArray(parsed)
        ? (parsed as ClayRow[])
        : Array.isArray((parsed as { rows?: unknown }).rows)
          ? ((parsed as { rows: ClayRow[] }).rows)
          : [parsed as ClayRow];

      try {
        const results = await intake.ingestRows(rows);
        respond(200, { results });
      } catch (err) {
        respond(500, { error: (err as Error).message });
      }
    });
  });
}
