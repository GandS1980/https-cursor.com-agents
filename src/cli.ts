import { SalesWrapper } from "./sales-wrapper";
import { createClayIntakeServer } from "./modules/clay-intake";

/**
 * Simple CLI runner demonstrating the SalesWrapper.
 * Usage: npx ts-node src/cli.ts
 */
async function main() {
  const wrapper = new SalesWrapper();

  const command = process.argv[2];

  switch (command) {
    case "ingest": {
      const name = process.argv[3] || "Jane Doe";
      const company = process.argv[4] || "Acme Corp";
      const email = process.argv[5] || "jane@acme.com";
      const source = process.argv[6] || "website";

      console.log(`Ingesting prospect: ${name} @ ${company}...`);
      const result = await wrapper.processInboundLead({
        name,
        company,
        email,
        source,
      });

      console.log(`Lead ID: ${result.lead.id}`);
      console.log(`Score: ${result.lead.score}/100`);
      console.log(`Qualified: ${result.qualified}`);

      if (result.appointment) {
        console.log(`Appointment scheduled: ${result.appointment.scheduledAt}`);
      }
      if (result.outreach) {
        console.log(`\nOutreach message:\n${result.outreach}`);
      }
      break;
    }

    case "metrics": {
      console.log(wrapper.getSummary());
      break;
    }

    case "demo": {
      console.log("Running demo workflow...\n");

      // 1) Ingest leads
      console.log("Step 1: Ingesting prospects...");
      const prospects = [
        { name: "Alice Chen", company: "TechStart Inc", email: "alice@techstart.io", source: "linkedin" },
        { name: "Bob Martinez", company: "ScaleUp Labs", email: "bob@scaleuplabs.com", source: "referral" },
        { name: "Carol Williams", company: "Enterprise Co", email: "carol@enterprise.co", source: "inbound" },
      ];

      for (const p of prospects) {
        const result = await wrapper.processInboundLead(p);
        console.log(`  ${p.name}: score=${result.lead.score}, qualified=${result.qualified}`);
      }

      // 2) Show metrics
      console.log("\n" + wrapper.getSummary());
      break;
    }

    case "serve": {
      const port = Number(process.argv[3] || process.env.PORT || 3000);
      const server = createClayIntakeServer(wrapper);
      server.listen(port, () => {
        console.log(`Clay intake listening on http://localhost:${port}/clay/leads`);
        if (!process.env.CLAY_WEBHOOK_SECRET) {
          console.log("Warning: CLAY_WEBHOOK_SECRET not set — endpoint is unauthenticated");
        }
      });
      break;
    }

    default: {
      console.log(`
OpenClaw Sales Wrapper CLI
==========================

Commands:
  ingest <name> <company> <email> <source>   Ingest and qualify a prospect
  metrics                                     Show pipeline metrics
  demo                                        Run a demo workflow
  serve [port]                                Start the Clay webhook intake server

Environment variables:
  OPENCLAW_API_KEY      Your OpenClaw API key
  OPENCLAW_BASE_URL     OpenClaw API base URL (default: https://api.openclaw.ai)
  OPENCLAW_MODEL        Model to use (default: openclaw-default)
  CLAY_WEBHOOK_SECRET   Shared secret required in x-clay-webhook-secret header
  PORT                  Port for the intake server (default: 3000)
`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
