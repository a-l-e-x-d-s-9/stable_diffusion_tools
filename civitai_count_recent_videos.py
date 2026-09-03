#!/usr/bin/env python3
"""Count a user's public PG and PG13 Civitai videos in a rolling time window."""

from __future__ import annotations

import argparse
import sys
import time
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Any, Iterator

import requests


API_URL = "https://civitai.com/api/v1/images"
PAGE_SIZE = 200
REQUEST_TIMEOUT_SECONDS = 30
MAX_RETRIES = 4
RATING_NAMES = {1: "PG", 2: "PG13"}


class CivitaiAPIError(RuntimeError):
    """Raised when an exact result cannot be obtained from the public API."""


def parse_civitai_datetime(value: str) -> datetime:
    """Parse a Civitai ISO-8601 timestamp and return an aware UTC datetime."""
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError) as exc:
        raise CivitaiAPIError(f"Invalid createdAt timestamp from Civitai: {value!r}") from exc

    if parsed.tzinfo is None:
        raise CivitaiAPIError(f"Civitai returned a timezone-less createdAt: {value!r}")
    return parsed.astimezone(timezone.utc)


def get_json_with_retries(
    session: requests.Session, params: dict[str, Any]
) -> dict[str, Any]:
    """Fetch one API page, retrying transient failures."""
    for attempt in range(MAX_RETRIES + 1):
        try:
            response = session.get(
                API_URL,
                params=params,
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
        except requests.RequestException as exc:
            if attempt == MAX_RETRIES:
                raise CivitaiAPIError(f"Civitai request failed: {exc}") from exc
        else:
            if response.status_code == 200:
                try:
                    payload = response.json()
                except requests.JSONDecodeError as exc:
                    raise CivitaiAPIError("Civitai returned invalid JSON") from exc
                if not isinstance(payload, dict):
                    raise CivitaiAPIError("Civitai returned an unexpected JSON response")
                return payload

            if response.status_code not in {429, 500, 502, 503, 504}:
                detail = response.text.strip().replace("\n", " ")[:300]
                raise CivitaiAPIError(
                    f"Civitai returned HTTP {response.status_code}: {detail or response.reason}"
                )
            if attempt == MAX_RETRIES:
                raise CivitaiAPIError(
                    f"Civitai still returned HTTP {response.status_code} after retries"
                )

        time.sleep(2**attempt)

    raise AssertionError("retry loop ended unexpectedly")


def iter_recent_videos(
    username: str,
    cutoff: datetime,
    session: requests.Session,
) -> Iterator[dict[str, Any]]:
    """Yield public PG/PG13 videos at or after cutoff, newest first."""
    params: dict[str, Any] = {
        "username": username,
        "type": "video",
        "sort": "Newest",
        "limit": PAGE_SIZE,
        # Civitai ratings are bit flags: PG=1 and PG13=2; request both.
        "browsingLevel": 1 | 2,
    }
    previous_timestamp: datetime | None = None
    cursors_seen: set[str] = set()

    while True:
        payload = get_json_with_retries(session, params)
        items = payload.get("items")
        if not isinstance(items, list):
            raise CivitaiAPIError("Civitai response has no valid 'items' list")

        reached_cutoff = False
        for item in items:
            if not isinstance(item, dict):
                raise CivitaiAPIError("Civitai returned a non-object item")
            if item.get("type") != "video":
                raise CivitaiAPIError(
                    f"Civitai returned non-video item {item.get('id')!r} for a video query"
                )

            created_at = parse_civitai_datetime(item.get("createdAt"))
            if previous_timestamp is not None and created_at > previous_timestamp:
                raise CivitaiAPIError(
                    "Civitai's Newest results were not time-sorted; refusing an inexact count"
                )
            previous_timestamp = created_at

            if created_at < cutoff:
                reached_cutoff = True
                continue
            yield item

        if reached_cutoff:
            return

        metadata = payload.get("metadata")
        if not isinstance(metadata, dict):
            raise CivitaiAPIError("Civitai response has no valid 'metadata' object")
        next_cursor = metadata.get("nextCursor")
        if not next_cursor:
            return
        next_cursor = str(next_cursor)
        if next_cursor in cursors_seen:
            raise CivitaiAPIError("Civitai repeated a pagination cursor")
        cursors_seen.add(next_cursor)
        params["cursor"] = next_cursor


def count_videos(
    username: str,
    cutoff: datetime,
    session: requests.Session,
) -> tuple[Counter[str], int]:
    """Return rating counts and the number of duplicate IDs ignored."""
    counts: Counter[str] = Counter()
    seen_ids: set[int] = set()
    duplicates = 0

    for item in iter_recent_videos(username, cutoff, session):
        video_id = item.get("id")
        if not isinstance(video_id, int):
            raise CivitaiAPIError(f"Video has an invalid ID: {video_id!r}")
        if video_id in seen_ids:
            duplicates += 1
            continue
        seen_ids.add(video_id)

        browsing_level = item.get("browsingLevel")
        rating = RATING_NAMES.get(browsing_level)
        if rating is None:
            raise CivitaiAPIError(
                f"Video {video_id} has unexpected browsingLevel {browsing_level!r}; "
                "refusing an inexact count"
            )
        counts[rating] += 1

    return counts, duplicates


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Count public PG and PG13 videos posted by a Civitai user during an "
            "exact rolling UTC window."
        )
    )
    parser.add_argument(
        "--username",
        default="alexds9",
        help="Civitai username (default: alexds9)",
    )
    parser.add_argument(
        "--days",
        type=float,
        default=30,
        help="Rolling window length in days (default: 30)",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.days <= 0:
        print("error: --days must be greater than zero", file=sys.stderr)
        return 2

    as_of = datetime.now(timezone.utc)
    cutoff = as_of - timedelta(days=args.days)
    session = requests.Session()
    session.headers.update(
        {
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 CivitaiVideoCounter/1.0",
        }
    )

    try:
        counts, duplicates = count_videos(args.username, cutoff, session)
    except CivitaiAPIError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    pg = counts["PG"]
    pg13 = counts["PG13"]
    print(f"Civitai user: {args.username}")
    print(f"Window (UTC): {cutoff.isoformat()} through {as_of.isoformat()}")
    print(f"PG videos: {pg}")
    print(f"PG13 videos: {pg13}")
    print(f"PG + PG13 videos: {pg + pg13}")
    if duplicates:
        print(f"Duplicate API items ignored: {duplicates}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
