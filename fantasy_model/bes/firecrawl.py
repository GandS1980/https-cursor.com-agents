"""Firecrawl ingestion for injury news and outside projections.

Requires FIRECRAWL_API_KEY. Sources are listed in config/sources.yaml. Every page is stored
raw (markdown) with fetched_at / published_at so backtests can tell what was knowable when.

Design choice: parsed news does NOT silently change projections. News flags surface in the
dashboard, where you confirm them as scenario overrides (active / limited / inactive).
Outside projection tables are parsed into `external_projections` and used as a backtest baseline.
"""
from __future__ import annotations

import datetime as dt
import os
import re
from pathlib import Path

import pandas as pd
import requests
import yaml

from . import db

API = "https://api.firecrawl.dev/v1/scrape"
STATUS_WORDS = {
    "inactive": r"\b(ruled out|will not play|won't play|inactive|placed on (?:injured reserve|ir)|out for)\b",
    "doubtful": r"\bdoubtful\b",
    "limited": r"\b(limited|snap count|pitch count|questionable|game-time decision|gtd)\b",
    "active": r"\b(will play|expected to play|cleared|full participant|off the injury report)\b",
}


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)


def scrape(url: str, api_key: str | None = None, timeout: int = 90) -> dict:
    key = api_key or os.environ.get("FIRECRAWL_API_KEY")
    if not key:
        raise RuntimeError("Set FIRECRAWL_API_KEY to use Firecrawl sources")
    r = requests.post(API, json={"url": url, "formats": ["markdown"], "onlyMainContent": True},
                      headers={"Authorization": f"Bearer {key}"}, timeout=timeout)
    r.raise_for_status()
    data = r.json().get("data", {})
    meta = data.get("metadata", {}) or {}
    return {"markdown": data.get("markdown", ""),
            "published_at": meta.get("publishedTime") or meta.get("article:published_time")}


def parse_markdown_tables(md: str) -> list[pd.DataFrame]:
    """Extract GitHub-style markdown tables from scraped content."""
    tables, block = [], []
    for line in md.splitlines() + [""]:
        if line.strip().startswith("|"):
            block.append(line.strip())
        elif block:
            rows = [[c.strip() for c in b.strip("|").split("|")] for b in block
                    if not re.fullmatch(r"\|?[\s:\-|]+\|?", b)]
            if len(rows) >= 2:
                width = len(rows[0])
                tables.append(pd.DataFrame([r[:width] for r in rows[1:] if len(r) >= width], columns=rows[0]))
            block = []
    return tables


def news_flags(md: str, names: list[str], window: int = 160) -> pd.DataFrame:
    """Find roster player names in news text and the status language near them."""
    low = md.lower()
    out = []
    for name in names:
        for m in re.finditer(re.escape(name.lower()), low):
            ctx = low[max(0, m.start() - window): m.end() + window]
            for status, pat in STATUS_WORDS.items():
                if re.search(pat, ctx):
                    out.append({"player_name": name, "signal": status,
                                "context": md[max(0, m.start() - window): m.end() + window].replace("\n", " ")})
    return pd.DataFrame(out).drop_duplicates(["player_name", "signal"]) if out else \
        pd.DataFrame(columns=["player_name", "signal", "context"])


def run_sources(season: int, week: int, sources_file: str | Path = db.ROOT / "config/sources.yaml",
                log=print) -> None:
    cfg = yaml.safe_load(Path(sources_file).read_text()) or {}
    con = db.connect()
    for src in cfg.get("sources", []) or []:
        try:
            page = scrape(src["url"])
        except Exception as e:  # keep the refresh going; one bad source shouldn't block lineups
            log(f"firecrawl {src['name']}: FAILED {e}")
            continue
        fetched = _now()
        con.execute("INSERT INTO external_snapshots VALUES (?, ?, ?, ?, ?, ?, ?)",
                    [src["name"], src["url"], fetched, page["published_at"], season, week, page["markdown"]])
        if src.get("type") == "projections":
            mapping: dict = src.get("columns", {})
            for t in parse_markdown_tables(page["markdown"]):
                if not set(mapping).issubset(t.columns):
                    continue
                name_col = src.get("name_column", "Player")
                for _, row in t.iterrows():
                    for col, stat in mapping.items():
                        val = pd.to_numeric(str(row[col]).replace(",", ""), errors="coerce")
                        if pd.notna(val):
                            con.execute("INSERT INTO external_projections VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                                        [src["name"], fetched, season, week, str(row.get(name_col)),
                                         row.get("Team"), src.get("position"), None, stat, float(val)])
        log(f"firecrawl {src['name']}: stored ({len(page['markdown'])} chars)")
    con.close()
