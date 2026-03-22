#!/usr/bin/env python3
"""Generate a YouTube profile pack for promoting Fiverr services."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def load_brief(path: Path) -> dict:
    data = json.loads(path.read_text())
    if not isinstance(data, dict):
        raise ValueError("Input JSON must be an object.")
    return data


def as_list(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    text = str(value).strip()
    if not text:
        return []
    return [part.strip() for part in text.split(",") if part.strip()]


def join_or_placeholder(items: list[str], placeholder: str) -> str:
    return ", ".join(items) if items else placeholder


def first_or_placeholder(items: list[str], placeholder: str) -> str:
    return items[0] if items else placeholder


def bullet_list(items: list[str]) -> str:
    return "\n".join(f"- {item}" for item in items)


def build_pack(brief: dict) -> str:
    brand_name = brief.get("brand_name") or "Your Brand"
    fiverr_url = brief.get("fiverr_url") or "[add Fiverr URL]"
    services = as_list(brief.get("services"))
    proof_points = as_list(brief.get("proof_points"))
    languages = as_list(brief.get("languages"))
    ideal_client = brief.get("ideal_client") or "clients who need a reliable freelancer"
    tone = brief.get("tone") or "clear, credible, and helpful"
    market = brief.get("market") or "your target market"
    cta = brief.get("cta") or f"Hire me on Fiverr: {fiverr_url}"
    notes = brief.get("notes") or "Highlight the strongest proof point and keep the CTA easy to spot."

    primary_service = first_or_placeholder(services, "your core service")
    services_text = join_or_placeholder(services, "your services")
    proof_text = join_or_placeholder(proof_points, "fast communication, dependable delivery")
    language_text = join_or_placeholder(languages, "the user's preferred language")

    channel_options = [
        brand_name,
        f"{brand_name} Studio",
        f"{brand_name} {primary_service.title()}",
        f"{brand_name} for {ideal_client.title()}",
    ]

    video_ideas = [
        f"How {ideal_client} can get better results from {primary_service}",
        f"Behind the scenes: my {primary_service} workflow",
        f"3 mistakes buyers make before hiring {primary_service}",
        f"Case study: improving results with {primary_service}",
        f"What to prepare before you order {primary_service} on Fiverr",
    ]

    playlist_ideas = [
        "Start here / featured videos",
        f"{primary_service.title()} tutorials",
        "Client FAQs",
        "Case studies and before/after examples",
    ]

    sections = [
        f"# YouTube profile pack for {brand_name}",
        "",
        "## Summary",
        f"- Fiverr URL: {fiverr_url}",
        f"- Services: {services_text}",
        f"- Ideal client: {ideal_client}",
        f"- Tone: {tone}",
        f"- Market / language: {market}; {language_text}",
        "",
        "## Brand Positioning",
        f"I help {ideal_client} get better results with {services_text} through {tone} support focused on {proof_text}.",
        "",
        "## Channel Name Ideas",
        bullet_list(channel_options),
        "",
        "## YouTube Profile Copy",
        "### About section",
        f"{brand_name} helps {ideal_client} solve real business problems with {services_text}. Expect practical advice, walkthroughs, and examples that show how projects move from brief to delivery.",
        "",
        f"If you want done-for-you help, I offer {services_text} on Fiverr with an emphasis on {proof_text}. {cta}",
        "",
        "### Banner copy",
        f"- Headline: {primary_service.title()} for {ideal_client}",
        f"- Subheadline: {services_text} for {market}",
        f"- CTA: {cta}",
        "",
        "## Visual Direction",
        "- Avatar: clean headshot or brand mark that reads well at small size.",
        f"- Banner: emphasize {primary_service}, the audience ({ideal_client}), and one short CTA.",
        f"- Tone cues: {tone}.",
        "",
        "## Featured Video Concept",
        "Create a 45-90 second introduction that explains who you help, what you deliver, one proof point, and a direct invitation to visit Fiverr.",
        "",
        "## Launch Content Plan",
        bullet_list(video_ideas),
        "",
        "## Playlist Ideas",
        bullet_list(playlist_ideas),
        "",
        "## Manual Update Checklist",
        "- Confirm the user is signed in manually before touching account settings.",
        "- Update channel name, About text, links, and banner copy in that order.",
        "- Double-check that the CTA points to the correct Fiverr page.",
        f"- Review notes: {notes}",
    ]
    return "\n".join(sections)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="Path to a JSON brief file")
    args = parser.parse_args()

    brief = load_brief(Path(args.input))
    print(build_pack(brief))


if __name__ == "__main__":
    main()
