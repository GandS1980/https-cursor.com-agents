---
name: openclaw-youtube-fiverr
description: Create or refine a YouTube channel profile, launch checklist, and promotion plan for a Fiverr freelancer or agency. Use when Codex or OpenClaw needs to gather creator inputs, draft channel branding, write an About section, banner/tagline copy, featured video ideas, playlist ideas, or guide a user through a safe manual login flow for updating YouTube without requesting or storing passwords.
---

# OpenClaw YouTube Fiverr

## Overview

Use this skill to help a freelancer turn a Fiverr offering into a credible YouTube presence. Gather the business inputs, generate a reusable profile pack, and guide any platform changes through a user-driven login flow instead of handling credentials directly.

## Workflow

### 1. Confirm scope and account ownership

Start by confirming that the YouTube channel and Fiverr account belong to the user or that the user is explicitly authorized to manage them.

If the user asks for login automation:
- Instruct the user to sign in themselves.
- Never ask for, store, or replay passwords, backup codes, session cookies, or MFA codes.
- Never suggest bypassing CAPTCHA, risk checks, or platform security prompts.
- Continue only after the user confirms a live authenticated session is available.

### 2. Collect the minimum profile brief

Ask for only the fields needed to produce a usable profile pack:
- Fiverr profile URL
- Primary service(s)
- Ideal client
- Geographic market or language
- Differentiators and proof points
- Tone of voice
- Existing brand name or preferred channel name
- Contact and CTA preferences

If details are missing, make conservative assumptions and label them clearly.

### 3. Build the channel profile pack

Produce these core outputs:
- Channel positioning sentence
- 3-5 channel name or handle options
- Channel description / About text
- Banner headline and subheadline
- Avatar and banner creative brief
- Featured video concept with CTA to Fiverr
- First 5 video ideas tied to the Fiverr offer
- Playlist structure
- External links and CTA order

Use `scripts/generate_channel_pack.py` when the user provides structured input or when a reusable markdown deliverable would help.

### 4. Guide the update flow

When the user wants help applying the work inside YouTube:
1. Confirm they are already logged in manually.
2. Tell them exactly which profile fields to update.
3. Paste or adapt the generated copy.
4. Pause for confirmation before moving to the next UI step.

Prefer a human-in-the-loop workflow for anything that changes account settings, publishes public content, or touches billing/contact details.

### 5. Keep the promotion compliant and credible

Optimize for legitimate lead generation, not spam.
- Represent the Fiverr services truthfully.
- Avoid fake testimonials, fake subscriber claims, or misleading guarantees.
- Avoid mass-comment spam, auto-DMs, or prohibited engagement tactics.
- Prefer educational content, portfolio walkthroughs, FAQ videos, and before/after case studies.

## Output standard

Default to a concise package with these sections:
- `Summary`
- `Brand Positioning`
- `YouTube Profile Copy`
- `Visual Direction`
- `Launch Content Plan`
- `Manual Update Checklist`

Keep copy ready to paste. Favor short paragraphs, bullets, and explicit CTA language.

## References

Read `references/youtube-fiverr-playbook.md` when you need:
- Intake questions
- Strong CTA patterns
- Video angle ideas by service type
- A quality checklist before publishing

## Script

Run `python scripts/generate_channel_pack.py --input <brief.json>` to convert a structured brief into a markdown channel pack.

The JSON input should contain fields such as:
- `brand_name`
- `fiverr_url`
- `services`
- `ideal_client`
- `tone`
- `proof_points`
- `cta`
- `languages`
- `market`
- `notes`

If some fields are absent, the script fills sensible placeholders so the draft can still be reviewed with the user.
