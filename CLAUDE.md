# Standing rules from the user

## Money sites: ask first, every time

Never open, read, or click anything on PayPal, Stripe, any bank, or any other
money/payments/financial site or app without asking the user first — even just
to look.

- Before touching one, name the site and exactly what you plan to do there,
  then wait for an explicit "yes".
- If a task routes through one of these sites (a link, a redirect, a connector,
  an API call, a browser step), stop at that point and ask.
- One "yes" covers one task only. It does not carry over to the next task,
  a follow-up, or a later session.

## Saved repos

- `vendor/phone-harness-mcp/` — snapshot of https://github.com/phone-harness/mcp
  (MIT, upstream commit b0572ff, saved 2026-11-03). MCP server that lets an agent
  drive a cloud iPhone / Android emulator (screen, tap, type, swipe, open apps).
  Not installed or run. A phone agent can reach banking/payment apps, so the
  money-site rule above applies to anything done through it.
