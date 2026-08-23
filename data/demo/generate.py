#!/usr/bin/env python3
"""Deterministic demo dataset generator for DraftCourt Phase 1.

Produces data/demo/{teams,players,player_season_stats,adp_observations,
news_signals,projection_overrides_seed}.json and data/demo/manifest.json.

Policy (see data/attribution/demo-dataset.md for the full statement):
  - Team/player names, teams, and positions are real, public NBA facts,
    reflecting this script's knowledge cutoff (~January 2026) — not
    verified against any live source, and may not match every roster
    transaction since then.
  - Every statistic, projection, ADP number, news signal, and override in
    this dataset is entirely fabricated by the seeded RNG below. None of
    it is a real player's real career output.
  - No real player is ever assigned SUSPENDED or UNSIGNED status — those
    two statuses (reputationally loaded / requires asserting a real
    person's current employment state) are reserved for clearly
    synthetic, generically-named filler players (`isSyntheticFiller:
    true`). ACTIVE and INJURED are used on real players — both are
    common, unremarkable, constantly-changing real-world statuses and
    this dataset is a labeled, timestamped fabricated snapshot, not a
    live claim.
  - No real player/team photos are used anywhere in DraftCourt; this
    dataset carries no image assets at all.
  - Deterministic: a fixed integer seed drives every random choice, and
    every timestamp in the output is a fixed literal, not wall-clock time.
    Re-running this script produces byte-identical output — see
    `verify_determinism()` below, exercised by
    services/analytics/tests/test_demo_dataset.py.

Usage: `python3 data/demo/generate.py` (stdlib only, no dependencies).
"""

from __future__ import annotations

import hashlib
import json
import random
import sys
import tempfile
from pathlib import Path
from typing import Any, Literal

SEED = 20260820
GENERATED_AT = "2026-08-20T00:00:00Z"
DATASET_VERSION = "2026.1"
CURRENT_SEASON = "2026-27"
NBA_SEASONS = ["2023-24", "2024-25", "2025-26"]
ADP_CAPTURE_AT = "2026-08-15T00:00:00Z"
OUT_DIR = Path(__file__).resolve().parent

DISCLAIMER = (
    "DEMO — SYNTHETIC DATA. Player, team, and position information reflects "
    "real, public NBA facts as of this generator's knowledge cutoff (~January "
    "2026) and may not match every roster transaction since then. Every "
    "statistic, projection, ADP value, injury/role signal, and override in "
    "this dataset is entirely fabricated for demonstration purposes and must "
    "never be treated as a real 2026-27 NBA fantasy projection. A small "
    "number of bench-depth entries use generic placeholder names instead of "
    "real players (see data/attribution/demo-dataset.md). No real player or "
    "team photos are used anywhere in DraftCourt."
)

# ---------------------------------------------------------------------------
# Teams: (abbreviation, city, name, conference, division, colorPrimary, colorSecondary)
# ---------------------------------------------------------------------------

TEAMS: list[tuple[str, str, str, str, str, str, str]] = [
    ("BOS", "Boston", "Celtics", "EAST", "ATLANTIC", "#007A33", "#BA9653"),
    ("BKN", "Brooklyn", "Nets", "EAST", "ATLANTIC", "#000000", "#FFFFFF"),
    ("NYK", "New York", "Knicks", "EAST", "ATLANTIC", "#006BB6", "#F58426"),
    ("PHI", "Philadelphia", "76ers", "EAST", "ATLANTIC", "#006BB6", "#ED174C"),
    ("TOR", "Toronto", "Raptors", "EAST", "ATLANTIC", "#CE1141", "#000000"),
    ("CHI", "Chicago", "Bulls", "EAST", "CENTRAL", "#CE1141", "#000000"),
    ("CLE", "Cleveland", "Cavaliers", "EAST", "CENTRAL", "#860038", "#FDBB30"),
    ("DET", "Detroit", "Pistons", "EAST", "CENTRAL", "#C8102E", "#1D42BA"),
    ("IND", "Indiana", "Pacers", "EAST", "CENTRAL", "#002D62", "#FDBB30"),
    ("MIL", "Milwaukee", "Bucks", "EAST", "CENTRAL", "#00471B", "#EEE1C6"),
    ("ATL", "Atlanta", "Hawks", "EAST", "SOUTHEAST", "#E03A3E", "#C1D32F"),
    ("CHA", "Charlotte", "Hornets", "EAST", "SOUTHEAST", "#1D1160", "#00788C"),
    ("MIA", "Miami", "Heat", "EAST", "SOUTHEAST", "#98002E", "#F9A01B"),
    ("ORL", "Orlando", "Magic", "EAST", "SOUTHEAST", "#0077C0", "#C4CED4"),
    ("WAS", "Washington", "Wizards", "EAST", "SOUTHEAST", "#002B5C", "#E31837"),
    ("DEN", "Denver", "Nuggets", "WEST", "NORTHWEST", "#0E2240", "#FEC524"),
    ("MIN", "Minnesota", "Timberwolves", "WEST", "NORTHWEST", "#0C2340", "#236192"),
    ("OKC", "Oklahoma City", "Thunder", "WEST", "NORTHWEST", "#007AC1", "#EF3B24"),
    ("POR", "Portland", "Trail Blazers", "WEST", "NORTHWEST", "#E03A3E", "#000000"),
    ("UTA", "Utah", "Jazz", "WEST", "NORTHWEST", "#002B5C", "#F9A01B"),
    ("GSW", "Golden State", "Warriors", "WEST", "PACIFIC", "#1D428A", "#FFC72C"),
    ("LAC", "LA", "Clippers", "WEST", "PACIFIC", "#C8102E", "#1D428A"),
    ("LAL", "Los Angeles", "Lakers", "WEST", "PACIFIC", "#552583", "#FDB927"),
    ("PHX", "Phoenix", "Suns", "WEST", "PACIFIC", "#1D1160", "#E56020"),
    ("SAC", "Sacramento", "Kings", "WEST", "PACIFIC", "#5A2D81", "#63727A"),
    ("DAL", "Dallas", "Mavericks", "WEST", "SOUTHWEST", "#00538C", "#002B5E"),
    ("HOU", "Houston", "Rockets", "WEST", "SOUTHWEST", "#CE1141", "#000000"),
    ("MEM", "Memphis", "Grizzlies", "WEST", "SOUTHWEST", "#5D76A9", "#12173F"),
    ("NOP", "New Orleans", "Pelicans", "WEST", "SOUTHWEST", "#0C2340", "#C8102E"),
    ("SAS", "San Antonio", "Spurs", "WEST", "SOUTHWEST", "#C4CED4", "#000000"),
]

Archetype = Literal["star", "starter", "rotation", "breakout", "decline", "rookie", "filler"]

# Roster entries: (display_name, positions, archetype, status, age_tier)
# age_tier in {"young","prime","veteran"} drives only the synthetic dob year.
# status is ACTIVE unless explicitly INJURED (a small, well-known, real set
# of injury situations) — never SUSPENDED/UNSIGNED on a real player.
Player = tuple[str, list[str], Archetype, str, str]

REAL_ROSTERS: dict[str, list[Player]] = {
    "BOS": [
        ("Jayson Tatum", ["SF", "PF"], "star", "ACTIVE", "prime"),
        ("Jaylen Brown", ["SG", "SF"], "star", "ACTIVE", "prime"),
        ("Derrick White", ["PG", "SG"], "starter", "ACTIVE", "prime"),
        ("Kristaps Porzingis", ["C", "PF"], "starter", "ACTIVE", "prime"),
        ("Jrue Holiday", ["PG", "SG"], "starter", "ACTIVE", "veteran"),
        ("Al Horford", ["C", "PF"], "rotation", "ACTIVE", "veteran"),
        ("Sam Hauser", ["SF"], "rotation", "ACTIVE", "prime"),
    ],
    "BKN": [
        ("Cam Thomas", ["SG"], "breakout", "ACTIVE", "young"),
        ("Nic Claxton", ["C"], "starter", "ACTIVE", "prime"),
        ("Cam Johnson", ["SF", "PF"], "starter", "ACTIVE", "prime"),
        ("Ben Simmons", ["PG", "SF"], "decline", "INJURED", "prime"),
        ("Dennis Schroder", ["PG"], "rotation", "ACTIVE", "veteran"),
        ("Noah Clowney", ["PF", "C"], "rotation", "ACTIVE", "young"),
        ("Day'Ron Sharpe", ["C"], "rotation", "ACTIVE", "young"),
    ],
    "NYK": [
        ("Jalen Brunson", ["PG"], "star", "ACTIVE", "prime"),
        ("Karl-Anthony Towns", ["C", "PF"], "star", "ACTIVE", "prime"),
        ("Mikal Bridges", ["SF", "SG"], "starter", "ACTIVE", "prime"),
        ("OG Anunoby", ["SF", "PF"], "starter", "ACTIVE", "prime"),
        ("Josh Hart", ["SG", "SF"], "starter", "ACTIVE", "prime"),
        ("Mitchell Robinson", ["C"], "rotation", "ACTIVE", "prime"),
        ("Miles McBride", ["PG", "SG"], "rotation", "ACTIVE", "young"),
    ],
    "PHI": [
        ("Joel Embiid", ["C"], "star", "INJURED", "prime"),
        ("Tyrese Maxey", ["PG", "SG"], "star", "ACTIVE", "young"),
        ("Paul George", ["SF", "SG"], "decline", "ACTIVE", "veteran"),
        ("VJ Edgecombe", ["SG"], "rookie", "ACTIVE", "young"),
        ("Kelly Oubre Jr.", ["SF"], "rotation", "ACTIVE", "prime"),
        ("Andre Drummond", ["C"], "rotation", "ACTIVE", "veteran"),
        ("Quentin Grimes", ["SG"], "rotation", "ACTIVE", "young"),
    ],
    "TOR": [
        ("Scottie Barnes", ["SF", "PF"], "star", "ACTIVE", "young"),
        ("RJ Barrett", ["SF", "SG"], "starter", "ACTIVE", "prime"),
        ("Immanuel Quickley", ["PG", "SG"], "starter", "ACTIVE", "prime"),
        ("Brandon Ingram", ["SF", "PF"], "starter", "ACTIVE", "prime"),
        ("Jakob Poeltl", ["C"], "rotation", "ACTIVE", "prime"),
        ("Gradey Dick", ["SG", "SF"], "breakout", "ACTIVE", "young"),
        ("Ochai Agbaji", ["SG", "SF"], "rotation", "ACTIVE", "young"),
    ],
    "CHI": [
        ("Coby White", ["PG", "SG"], "starter", "ACTIVE", "prime"),
        ("Josh Giddey", ["PG", "SG"], "starter", "ACTIVE", "young"),
        ("Nikola Vucevic", ["C"], "starter", "ACTIVE", "veteran"),
        ("Ayo Dosunmu", ["PG", "SG"], "rotation", "ACTIVE", "prime"),
        ("Matas Buzelis", ["SF", "PF"], "breakout", "ACTIVE", "young"),
        ("Patrick Williams", ["PF"], "rotation", "ACTIVE", "young"),
        ("Zach Collins", ["C"], "rotation", "ACTIVE", "prime"),
    ],
    "CLE": [
        ("Donovan Mitchell", ["SG", "PG"], "star", "ACTIVE", "prime"),
        ("Darius Garland", ["PG"], "starter", "ACTIVE", "prime"),
        ("Evan Mobley", ["PF", "C"], "star", "ACTIVE", "young"),
        ("Jarrett Allen", ["C"], "starter", "ACTIVE", "prime"),
        ("Max Strus", ["SG", "SF"], "rotation", "ACTIVE", "prime"),
        ("De'Andre Hunter", ["SF", "PF"], "rotation", "ACTIVE", "prime"),
        ("Ty Jerome", ["PG", "SG"], "rotation", "ACTIVE", "prime"),
    ],
    "DET": [
        ("Cade Cunningham", ["PG"], "star", "ACTIVE", "young"),
        ("Jaden Ivey", ["SG", "PG"], "starter", "ACTIVE", "young"),
        ("Jalen Duren", ["C"], "starter", "ACTIVE", "young"),
        ("Ausar Thompson", ["SF"], "breakout", "ACTIVE", "young"),
        ("Tobias Harris", ["SF", "PF"], "rotation", "ACTIVE", "veteran"),
        ("Ron Holland", ["SF", "PF"], "rotation", "ACTIVE", "young"),
        ("Duncan Robinson", ["SG", "SF"], "rotation", "ACTIVE", "prime"),
    ],
    "IND": [
        ("Tyrese Haliburton", ["PG"], "star", "ACTIVE", "prime"),
        ("Pascal Siakam", ["PF", "SF"], "star", "ACTIVE", "veteran"),
        ("Andrew Nembhard", ["PG", "SG"], "starter", "ACTIVE", "young"),
        ("Bennedict Mathurin", ["SG", "SF"], "starter", "ACTIVE", "young"),
        ("Aaron Nesmith", ["SF"], "rotation", "ACTIVE", "prime"),
        ("Obi Toppin", ["PF"], "rotation", "ACTIVE", "prime"),
        ("T.J. McConnell", ["PG"], "rotation", "ACTIVE", "veteran"),
    ],
    "MIL": [
        ("Giannis Antetokounmpo", ["PF", "C"], "star", "ACTIVE", "prime"),
        ("Damian Lillard", ["PG"], "decline", "INJURED", "veteran"),
        ("Kyle Kuzma", ["SF", "PF"], "starter", "ACTIVE", "prime"),
        ("Bobby Portis", ["PF", "C"], "rotation", "ACTIVE", "prime"),
        ("AJ Green", ["SG"], "rotation", "ACTIVE", "young"),
        ("Ryan Rollins", ["PG", "SG"], "rotation", "ACTIVE", "young"),
        ("Gary Trent Jr.", ["SG", "SF"], "rotation", "ACTIVE", "prime"),
    ],
    "ATL": [
        ("Trae Young", ["PG"], "star", "ACTIVE", "prime"),
        ("Jalen Johnson", ["SF", "PF"], "breakout", "ACTIVE", "young"),
        ("Zaccharie Risacher", ["SF"], "starter", "ACTIVE", "young"),
        ("Dyson Daniels", ["SG", "PG"], "starter", "ACTIVE", "young"),
        ("Onyeka Okongwu", ["C", "PF"], "starter", "ACTIVE", "young"),
        ("Nickeil Alexander-Walker", ["SG", "PG"], "rotation", "ACTIVE", "prime"),
        ("Caris LeVert", ["SG", "SF"], "rotation", "ACTIVE", "prime"),
    ],
    "CHA": [
        ("LaMelo Ball", ["PG"], "star", "ACTIVE", "prime"),
        ("Brandon Miller", ["SF"], "breakout", "ACTIVE", "young"),
        ("Miles Bridges", ["SF", "PF"], "starter", "ACTIVE", "prime"),
        ("Mark Williams", ["C"], "starter", "ACTIVE", "young"),
        ("Josh Green", ["SG", "SF"], "rotation", "ACTIVE", "young"),
        ("Tidjane Salaun", ["PF"], "rotation", "ACTIVE", "young"),
        ("Grant Williams", ["PF", "C"], "rotation", "ACTIVE", "prime"),
    ],
    "MIA": [
        ("Bam Adebayo", ["C", "PF"], "star", "ACTIVE", "prime"),
        ("Tyler Herro", ["SG", "PG"], "star", "ACTIVE", "prime"),
        ("Jaime Jaquez Jr.", ["SF", "SG"], "starter", "ACTIVE", "young"),
        ("Kel'el Ware", ["C"], "starter", "ACTIVE", "young"),
        ("Andrew Wiggins", ["SF", "PF"], "rotation", "ACTIVE", "prime"),
        ("Davion Mitchell", ["PG"], "rotation", "ACTIVE", "prime"),
        ("Nikola Jovic", ["SF", "PF"], "rotation", "ACTIVE", "young"),
    ],
    "ORL": [
        ("Paolo Banchero", ["PF", "SF"], "star", "ACTIVE", "young"),
        ("Franz Wagner", ["SF", "SG"], "star", "ACTIVE", "young"),
        ("Jalen Suggs", ["PG", "SG"], "starter", "ACTIVE", "young"),
        ("Wendell Carter Jr.", ["C", "PF"], "starter", "ACTIVE", "prime"),
        ("Anthony Black", ["PG", "SG"], "rotation", "ACTIVE", "young"),
        ("Desmond Bane", ["SG", "SF"], "starter", "ACTIVE", "prime"),
        ("Goga Bitadze", ["C"], "rotation", "ACTIVE", "prime"),
    ],
    "WAS": [
        ("Alex Sarr", ["C", "PF"], "breakout", "ACTIVE", "young"),
        ("Bilal Coulibaly", ["SG", "SF"], "starter", "ACTIVE", "young"),
        ("Jordan Poole", ["PG", "SG"], "starter", "ACTIVE", "prime"),
        ("CJ McCollum", ["SG", "PG"], "decline", "ACTIVE", "veteran"),
        ("Kyshawn George", ["SF"], "rotation", "ACTIVE", "young"),
        ("Corey Kispert", ["SF"], "rotation", "ACTIVE", "prime"),
        ("Tre Johnson", ["SG"], "rookie", "ACTIVE", "young"),
    ],
    "DEN": [
        ("Nikola Jokic", ["C"], "star", "ACTIVE", "prime"),
        ("Jamal Murray", ["PG", "SG"], "star", "ACTIVE", "prime"),
        ("Aaron Gordon", ["PF", "SF"], "starter", "ACTIVE", "prime"),
        ("Christian Braun", ["SG", "SF"], "starter", "ACTIVE", "young"),
        ("Peyton Watson", ["SF"], "breakout", "ACTIVE", "young"),
        ("Julian Strawther", ["SG", "SF"], "rotation", "ACTIVE", "young"),
        ("Zeke Nnaji", ["PF", "C"], "rotation", "ACTIVE", "young"),
    ],
    "MIN": [
        ("Anthony Edwards", ["SG", "SF"], "star", "ACTIVE", "young"),
        ("Rudy Gobert", ["C"], "starter", "ACTIVE", "prime"),
        ("Julius Randle", ["PF", "SF"], "starter", "ACTIVE", "prime"),
        ("Jaden McDaniels", ["SF", "PF"], "starter", "ACTIVE", "young"),
        ("Mike Conley", ["PG"], "rotation", "ACTIVE", "veteran"),
        ("Naz Reid", ["PF", "C"], "rotation", "ACTIVE", "prime"),
        ("Donte DiVincenzo", ["SG", "PG"], "rotation", "ACTIVE", "prime"),
    ],
    "OKC": [
        ("Shai Gilgeous-Alexander", ["PG", "SG"], "star", "ACTIVE", "prime"),
        ("Chet Holmgren", ["C", "PF"], "star", "ACTIVE", "young"),
        ("Jalen Williams", ["SG", "SF"], "star", "ACTIVE", "young"),
        ("Luguentz Dort", ["SG", "SF"], "starter", "ACTIVE", "prime"),
        ("Isaiah Hartenstein", ["C"], "starter", "ACTIVE", "prime"),
        ("Cason Wallace", ["PG", "SG"], "rotation", "ACTIVE", "young"),
        ("Aaron Wiggins", ["SG", "SF"], "rotation", "ACTIVE", "prime"),
    ],
    "POR": [
        ("Scoot Henderson", ["PG"], "breakout", "ACTIVE", "young"),
        ("Deni Avdija", ["SF", "PF"], "starter", "ACTIVE", "young"),
        ("Shaedon Sharpe", ["SG", "SF"], "starter", "ACTIVE", "young"),
        ("Donovan Clingan", ["C"], "starter", "ACTIVE", "young"),
        ("Jerami Grant", ["PF", "SF"], "starter", "ACTIVE", "prime"),
        ("Toumani Camara", ["SF", "PF"], "rotation", "ACTIVE", "young"),
        ("Robert Williams III", ["C"], "rotation", "ACTIVE", "prime"),
    ],
    "UTA": [
        ("Lauri Markkanen", ["PF", "SF"], "star", "ACTIVE", "prime"),
        ("Walker Kessler", ["C"], "starter", "ACTIVE", "young"),
        ("Keyonte George", ["PG", "SG"], "starter", "ACTIVE", "young"),
        ("Ace Bailey", ["SF"], "rookie", "ACTIVE", "young"),
        ("Isaiah Collier", ["PG"], "rotation", "ACTIVE", "young"),
        ("Taylor Hendricks", ["PF"], "rotation", "ACTIVE", "young"),
        ("John Collins", ["PF", "C"], "rotation", "ACTIVE", "prime"),
    ],
    "GSW": [
        ("Stephen Curry", ["PG"], "star", "ACTIVE", "veteran"),
        ("Draymond Green", ["PF", "C"], "starter", "ACTIVE", "veteran"),
        ("Jonathan Kuminga", ["SF", "PF"], "breakout", "ACTIVE", "young"),
        ("Jimmy Butler", ["SF", "PF"], "star", "ACTIVE", "veteran"),
        ("Brandin Podziemski", ["SG", "PG"], "rotation", "ACTIVE", "young"),
        ("Moses Moody", ["SG", "SF"], "rotation", "ACTIVE", "young"),
        ("Buddy Hield", ["SG"], "rotation", "ACTIVE", "prime"),
    ],
    "LAC": [
        ("James Harden", ["PG", "SG"], "star", "ACTIVE", "veteran"),
        ("Kawhi Leonard", ["SF", "PF"], "star", "INJURED", "veteran"),
        ("Ivica Zubac", ["C"], "starter", "ACTIVE", "prime"),
        ("Norman Powell", ["SG", "SF"], "starter", "ACTIVE", "prime"),
        ("Derrick Jones Jr.", ["SF"], "rotation", "ACTIVE", "prime"),
        ("Bogdan Bogdanovic", ["SG", "SF"], "rotation", "ACTIVE", "veteran"),
        ("Kris Dunn", ["PG"], "rotation", "ACTIVE", "veteran"),
    ],
    "LAL": [
        ("LeBron James", ["SF", "PF"], "decline", "ACTIVE", "veteran"),
        ("Luka Doncic", ["PG", "SG"], "star", "ACTIVE", "prime"),
        ("Austin Reaves", ["SG", "PG"], "breakout", "ACTIVE", "prime"),
        ("Rui Hachimura", ["PF", "SF"], "rotation", "ACTIVE", "prime"),
        ("Jaxson Hayes", ["C"], "rotation", "ACTIVE", "prime"),
        ("Gabe Vincent", ["PG", "SG"], "rotation", "ACTIVE", "prime"),
        ("Dalton Knecht", ["SG", "SF"], "rotation", "ACTIVE", "young"),
    ],
    "PHX": [
        ("Devin Booker", ["SG", "PG"], "star", "ACTIVE", "prime"),
        ("Bradley Beal", ["SG", "PG"], "decline", "ACTIVE", "veteran"),
        ("Jalen Green", ["SG"], "breakout", "ACTIVE", "young"),
        ("Dillon Brooks", ["SF", "SG"], "rotation", "ACTIVE", "prime"),
        ("Royce O'Neale", ["SF", "PF"], "rotation", "ACTIVE", "veteran"),
        ("Grayson Allen", ["SG"], "rotation", "ACTIVE", "prime"),
        ("Ryan Dunn", ["SF"], "rotation", "ACTIVE", "young"),
    ],
    "SAC": [
        ("Domantas Sabonis", ["C", "PF"], "star", "ACTIVE", "prime"),
        ("Zach LaVine", ["SG", "SF"], "starter", "ACTIVE", "prime"),
        ("DeMar DeRozan", ["SF", "SG"], "decline", "ACTIVE", "veteran"),
        ("Keegan Murray", ["PF", "SF"], "starter", "ACTIVE", "young"),
        ("Malik Monk", ["SG", "PG"], "rotation", "ACTIVE", "prime"),
        ("Devin Carter", ["PG", "SG"], "rotation", "ACTIVE", "young"),
        ("Keon Ellis", ["SG"], "rotation", "ACTIVE", "young"),
    ],
    "DAL": [
        ("Anthony Davis", ["PF", "C"], "star", "ACTIVE", "prime"),
        ("Kyrie Irving", ["PG", "SG"], "decline", "INJURED", "veteran"),
        ("Klay Thompson", ["SG", "SF"], "decline", "ACTIVE", "veteran"),
        ("Dereck Lively II", ["C"], "starter", "ACTIVE", "young"),
        ("P.J. Washington", ["PF", "SF"], "starter", "ACTIVE", "prime"),
        ("Cooper Flagg", ["SF", "PF"], "rookie", "ACTIVE", "young"),
        ("Naji Marshall", ["SF"], "rotation", "ACTIVE", "prime"),
    ],
    "HOU": [
        ("Kevin Durant", ["SF", "PF"], "star", "ACTIVE", "veteran"),
        ("Alperen Sengun", ["C"], "breakout", "ACTIVE", "young"),
        ("Fred VanVleet", ["PG"], "starter", "ACTIVE", "veteran"),
        ("Amen Thompson", ["SF", "PG"], "starter", "ACTIVE", "young"),
        ("Tari Eason", ["PF", "SF"], "rotation", "ACTIVE", "young"),
        ("Steven Adams", ["C"], "rotation", "ACTIVE", "veteran"),
        ("Reed Sheppard", ["PG", "SG"], "rotation", "ACTIVE", "young"),
    ],
    "MEM": [
        ("Ja Morant", ["PG"], "star", "ACTIVE", "prime"),
        ("Jaren Jackson Jr.", ["PF", "C"], "star", "ACTIVE", "prime"),
        ("Marcus Smart", ["PG", "SG"], "starter", "ACTIVE", "veteran"),
        ("Santi Aldama", ["PF", "C"], "rotation", "ACTIVE", "young"),
        ("GG Jackson", ["PF", "SF"], "breakout", "ACTIVE", "young"),
        ("Zach Edey", ["C"], "rotation", "ACTIVE", "young"),
        ("Scotty Pippen Jr.", ["PG"], "rotation", "ACTIVE", "young"),
    ],
    "NOP": [
        ("Zion Williamson", ["PF", "SF"], "star", "INJURED", "prime"),
        ("Dejounte Murray", ["PG", "SG"], "starter", "ACTIVE", "prime"),
        ("Trey Murphy III", ["SF", "SG"], "breakout", "ACTIVE", "young"),
        ("Herbert Jones", ["SF", "PF"], "rotation", "ACTIVE", "prime"),
        ("Yves Missi", ["C"], "rotation", "ACTIVE", "young"),
        ("Jose Alvarado", ["PG"], "rotation", "ACTIVE", "prime"),
        ("Derik Queen", ["C", "PF"], "rookie", "ACTIVE", "young"),
    ],
    "SAS": [
        ("Victor Wembanyama", ["C", "PF"], "star", "ACTIVE", "young"),
        ("De'Aaron Fox", ["PG", "SG"], "star", "ACTIVE", "prime"),
        ("Stephon Castle", ["SG", "PG"], "breakout", "ACTIVE", "young"),
        ("Devin Vassell", ["SG", "SF"], "starter", "ACTIVE", "young"),
        ("Jeremy Sochan", ["PF", "SF"], "rotation", "ACTIVE", "young"),
        ("Harrison Barnes", ["SF", "PF"], "rotation", "ACTIVE", "veteran"),
        ("Dylan Harper", ["PG"], "rookie", "ACTIVE", "young"),
    ],
}

# Clearly generic, non-identifying placeholder names for synthetic filler
# players — never a specific real person, real or retired.
FILLER_FIRST = [
    "Marcus",
    "Devon",
    "Trey",
    "Julian",
    "Isaiah",
    "Cameron",
    "Xavier",
    "Elijah",
    "Malik",
    "Trevon",
    "Brandon",
    "Corey",
    "Darius",
    "Jaylin",
    "Terrence",
]
FILLER_LAST = [
    "Brooks",
    "Hayward",
    "Sanders",
    "Whitfield",
    "Coleman",
    "Reeves",
    "Norwood",
    "Pierce",
    "Lindsey",
    "Marsh",
    "Holloway",
    "Winters",
    "Blake",
    "Sutton",
    "Rice",
]

AGE_TIER_YEAR_RANGE = {"young": (2002, 2006), "prime": (1995, 2002), "veteran": (1987, 1995)}
ARCHETYPE_MINUTES = {
    "star": (33.0, 37.5),
    "starter": (28.0, 33.0),
    "breakout": (26.0, 32.0),
    "decline": (22.0, 30.0),
    "rotation": (16.0, 25.0),
    "rookie": (14.0, 22.0),
    "filler": (6.0, 14.0),
}
ARCHETYPE_PTS = {
    "star": (23.0, 31.0),
    "starter": (14.0, 20.0),
    "breakout": (16.0, 22.0),
    "decline": (11.0, 17.0),
    "rotation": (7.0, 13.0),
    "rookie": (7.0, 13.0),
    "filler": (2.0, 6.0),
}
# Trend multipliers applied across [2023-24, 2024-25, 2025-26] (oldest -> newest).
ARCHETYPE_TREND = {
    "star": (0.96, 1.0, 1.02),
    "starter": (0.95, 1.0, 1.03),
    "breakout": (0.72, 0.88, 1.18),
    "decline": (1.18, 1.0, 0.80),
    "rotation": (0.94, 1.0, 1.04),
    "filler": (0.95, 1.0, 1.02),
}


def _rng_for(*parts: str) -> random.Random:
    """A deterministic, per-entity RNG stream derived from the global seed
    plus a stable key — keeps generation order-independent and reproducible
    without one giant shared RNG whose output shifts if unrelated code
    upstream consumes an extra random() call."""
    key = f"{SEED}:{'|'.join(parts)}"
    return random.Random(int(hashlib.sha256(key.encode()).hexdigest()[:16], 16))


def _synthetic_dob(tier: str, rng: random.Random) -> str:
    year = rng.randint(*AGE_TIER_YEAR_RANGE[tier])
    month = rng.randint(1, 12)
    day = rng.randint(1, 28)
    return f"{year:04d}-{month:02d}-{day:02d}"


def _gen_stat_line(
    rng: random.Random, archetype: Archetype, minutes_per_game: float, pts_per_game: float
) -> dict[str, float]:
    ft_share = rng.uniform(0.12, 0.22)
    ftm_pg = pts_per_game * ft_share
    ft_pct = rng.uniform(0.68, 0.90)
    fta_pg = ftm_pg / ft_pct

    three_rate = {"star": 3.2, "breakout": 2.6, "starter": 2.2}.get(archetype, 1.2)
    three_pm_pg = min(rng.uniform(0.3, three_rate), max(pts_per_game * 0.4 / 3, 0.2))
    three_pt_pct = rng.uniform(0.31, 0.41)
    three_pa_pg = three_pm_pg / three_pt_pct

    two_pt_pts = max(pts_per_game - ftm_pg - 3 * three_pm_pg, 0.5)
    two_pm_pg = two_pt_pts / 2
    fgm_pg = two_pm_pg + three_pm_pg
    fg_pct = rng.uniform(0.44, 0.58)
    fga_pg = max(fgm_pg / fg_pct, fgm_pg + 0.1)
    fga_pg = max(fga_pg, three_pa_pg + 0.1)

    reb_pg = rng.uniform(2.0, 6.0) if archetype not in ("star",) else rng.uniform(5.0, 11.0)
    ast_pg = rng.uniform(1.0, 4.5) if archetype not in ("star",) else rng.uniform(3.0, 9.5)
    stl_pg = rng.uniform(0.4, 1.6)
    blk_pg = rng.uniform(0.2, 1.4)
    tov_pg = rng.uniform(0.8, 3.2)

    return {
        "ptsPg": round(pts_per_game, 2),
        "rebPg": round(reb_pg, 2),
        "astPg": round(ast_pg, 2),
        "stlPg": round(stl_pg, 2),
        "blkPg": round(blk_pg, 2),
        "tovPg": round(tov_pg, 2),
        "fgmPg": round(fgm_pg, 3),
        "fgaPg": round(fga_pg, 3),
        "ftmPg": round(ftm_pg, 3),
        "ftaPg": round(fta_pg, 3),
        "threePmPg": round(three_pm_pg, 3),
    }


def _season_totals(
    per_game: dict[str, float], games_played: int, minutes_per_game: float
) -> dict[str, Any]:
    def total(key: str) -> float:
        return round(per_game[key] * games_played, 1)

    return {
        "gamesPlayed": games_played,
        "minutesTotal": round(minutes_per_game * games_played, 1),
        "pts": total("ptsPg"),
        "reb": total("rebPg"),
        "ast": total("astPg"),
        "stl": total("stlPg"),
        "blk": total("blkPg"),
        "tov": total("tovPg"),
        "fgm": total("fgmPg"),
        "fga": total("fgaPg"),
        "ftm": total("ftmPg"),
        "fta": total("ftaPg"),
        "threePm": total("threePmPg"),
    }


_SECOND_POSITION_CHANCE = 0.25
_SIGNAL_EXPIRY_CHANCE = 0.6


def _build_teams() -> list[dict[str, Any]]:
    return [
        {
            "externalKey": f"demo-team-{abbr}",
            "nbaProviderId": f"demo-team-{abbr}",
            "abbreviation": abbr,
            "name": f"{city} {name}",
            "city": city,
            "conference": conf,
            "division": division,
            "colorPrimary": primary,
            "colorSecondary": secondary,
        }
        for abbr, city, name, conf, division, primary, secondary in TEAMS
    ]


class _KeySequence:
    def __init__(self) -> None:
        self._seq = 0

    def next(self) -> str:
        self._seq += 1
        return f"demo-player-{self._seq:04d}"


def _build_real_players_and_stats(
    keys: _KeySequence,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    players: list[dict[str, Any]] = []
    season_stats: list[dict[str, Any]] = []

    for abbr, *_rest in TEAMS:
        for display_name, positions, archetype, status, tier in REAL_ROSTERS[abbr]:
            key = keys.next()
            rng = _rng_for("player", key)
            is_rookie = archetype == "rookie"
            players.append(
                {
                    "externalKey": key,
                    "displayName": display_name,
                    "legalName": display_name,
                    "dob": _synthetic_dob(tier, rng),
                    "teamExternalKey": f"demo-team-{abbr}",
                    "positions": positions,
                    "status": status,
                    "unsigned": False,
                    "rookie": is_rookie,
                    "draftYear": 2025 if is_rookie else None,
                    "archetype": archetype,
                    "isSyntheticFiller": False,
                }
            )

            if is_rookie:
                season_stats.append(_gen_rookie_college_stat(key))
            else:
                season_stats.extend(_gen_veteran_nba_stats(key, archetype, status, rng))

    return players, season_stats


def _gen_rookie_college_stat(key: str) -> dict[str, Any]:
    college_rng = _rng_for("college", key)
    college_minutes = college_rng.uniform(24.0, 32.0)
    college_pts = college_rng.uniform(11.0, 19.0)
    per_game = _gen_stat_line(college_rng, "rookie", college_minutes, college_pts)
    totals = _season_totals(per_game, college_rng.randint(28, 35), college_minutes)
    return {"playerExternalKey": key, "season": "college-2024-25", "scope": "COLLEGE", **totals}


def _gen_veteran_nba_stats(
    key: str, archetype: Archetype, status: str, rng: random.Random
) -> list[dict[str, Any]]:
    minutes_pg = rng.uniform(*ARCHETYPE_MINUTES[archetype])
    pts_pg = rng.uniform(*ARCHETYPE_PTS[archetype])
    trend = ARCHETYPE_TREND.get(archetype, ARCHETYPE_TREND["rotation"])

    rows: list[dict[str, Any]] = []
    for season, multiplier in zip(NBA_SEASONS, trend, strict=True):
        season_rng = _rng_for("season", key, season)
        season_minutes = minutes_pg * multiplier
        season_pts = pts_pg * multiplier
        games_played = (
            season_rng.randint(38, 55) if status == "INJURED" else season_rng.randint(58, 82)
        )
        per_game = _gen_stat_line(season_rng, archetype, season_minutes, season_pts)
        totals = _season_totals(per_game, games_played, season_minutes)
        rows.append({"playerExternalKey": key, "season": season, "scope": "NBA", **totals})
    return rows


def _filler_specs() -> list[tuple[str, str | None]]:
    specs: list[tuple[str, str | None]] = [
        ("SUSPENDED", "BOS"),
        ("SUSPENDED", "MIA"),
        ("UNSIGNED", None),
        ("UNSIGNED", None),
        ("UNSIGNED", None),
    ]
    specs += [("ACTIVE", abbr) for abbr, *_rest in TEAMS[:15]]  # extra bench depth
    return specs


def _build_filler_players_and_stats(
    keys: _KeySequence,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    players: list[dict[str, Any]] = []
    season_stats: list[dict[str, Any]] = []

    for status, team_abbr in _filler_specs():
        key = keys.next()
        rng = _rng_for("filler", key)
        first = FILLER_FIRST[rng.randrange(len(FILLER_FIRST))]
        last = FILLER_LAST[rng.randrange(len(FILLER_LAST))]
        positions = [rng.choice(["PG", "SG", "SF", "PF", "C"])]
        if rng.random() < _SECOND_POSITION_CHANCE:
            second = rng.choice(["PG", "SG", "SF", "PF", "C"])
            if second not in positions:
                positions.append(second)

        players.append(
            {
                "externalKey": key,
                "displayName": f"{first} {last}",
                "legalName": f"{first} {last}",
                "dob": _synthetic_dob(rng.choice(["young", "prime"]), rng),
                "teamExternalKey": f"demo-team-{team_abbr}" if team_abbr else None,
                "positions": positions,
                "status": status,
                "unsigned": status == "UNSIGNED",
                "rookie": False,
                "draftYear": None,
                "archetype": "filler",
                "isSyntheticFiller": True,
            }
        )

        minutes_pg = rng.uniform(*ARCHETYPE_MINUTES["filler"])
        pts_pg = rng.uniform(*ARCHETYPE_PTS["filler"])
        num_seasons = 1 if status == "UNSIGNED" else rng.randint(1, 2)
        for season in NBA_SEASONS[-num_seasons:]:
            season_rng = _rng_for("season", key, season)
            games_played = season_rng.randint(8, 30)
            per_game = _gen_stat_line(season_rng, "filler", minutes_pg, pts_pg)
            totals = _season_totals(per_game, games_played, minutes_pg)
            season_stats.append(
                {"playerExternalKey": key, "season": season, "scope": "NBA", **totals}
            )

    return players, season_stats


def _adp_priority(archetype: str) -> float:
    return {
        "star": 0.0,
        "breakout": 8.0,
        "starter": 20.0,
        "decline": 30.0,
        "rotation": 60.0,
        "rookie": 90.0,
        "filler": 150.0,
    }.get(archetype, 100.0)


def _build_adp_observations(players: list[dict[str, Any]]) -> list[dict[str, Any]]:
    observations: list[dict[str, Any]] = []
    non_unsigned_players = [p for p in players if p["status"] != "UNSIGNED"]
    rank_order_rng = _rng_for("adp-rank-order")
    ranked = sorted(
        non_unsigned_players,
        key=lambda p: rank_order_rng.random() + _adp_priority(p["archetype"]),
    )
    for idx, player in enumerate(ranked, start=1):
        base_adp = float(idx)
        for source_key in ("demo-adp-source-a", "demo-adp-source-b"):
            obs_rng = _rng_for("adp", player["externalKey"], source_key)
            adp_value = max(1.0, base_adp + obs_rng.uniform(-4.0, 4.0))
            observations.append(
                {
                    "playerExternalKey": player["externalKey"],
                    "sourceExternalKey": source_key,
                    "format": "OVERALL",
                    "season": CURRENT_SEASON,
                    "sampleSize": obs_rng.randint(800, 2000),
                    "adp": round(adp_value, 1),
                    "rank": max(1, round(adp_value)),
                    "capturedAt": ADP_CAPTURE_AT,
                }
            )
    return observations


def _build_news_signals(
    signal_pool: list[dict[str, Any]], rng: random.Random
) -> list[dict[str, Any]]:
    signal_types = ["INJURY", "TRADE", "STARTER_CHANGE", "ROLE_UP", "ROLE_DOWN"]
    signals: list[dict[str, Any]] = []
    chosen = rng.sample(signal_pool, k=min(14, len(signal_pool)))
    for i, player in enumerate(chosen):
        signal_type = signal_types[i % len(signal_types)]
        s_rng = _rng_for("signal", player["externalKey"], signal_type)
        has_expiry = s_rng.random() < _SIGNAL_EXPIRY_CHANCE
        scenario = signal_type.lower().replace("_", " ")
        signals.append(
            {
                "playerExternalKey": player["externalKey"],
                "type": signal_type,
                "impact": round(s_rng.uniform(-0.6, 0.6), 2),
                "confidence": round(s_rng.uniform(0.4, 0.95), 2),
                "rationale": f"Demo signal: illustrative {scenario} scenario for "
                "testing, not a real report.",
                "effectiveAt": "2026-08-10T00:00:00Z",
                "expiresAt": "2026-08-24T00:00:00Z" if has_expiry else None,
            }
        )
    return signals


def _build_override_seeds(
    signal_pool: list[dict[str, Any]], rng: random.Random
) -> list[dict[str, Any]]:
    override_pool = rng.sample(signal_pool, k=6)
    stats_cycle = ["pts", "reb", "ast", "minutesPerGame", "threePm", "stl"]
    overrides: list[dict[str, Any]] = []
    for i, player in enumerate(override_pool):
        stat = stats_cycle[i % len(stats_cycle)]
        o_rng = _rng_for("override", player["externalKey"], stat)
        use_delta = i % 2 == 0
        overrides.append(
            {
                "playerExternalKey": player["externalKey"],
                "season": CURRENT_SEASON,
                "stat": stat,
                "deltaValue": round(o_rng.uniform(-3.0, 3.0), 2) if use_delta else None,
                "replacementValue": round(o_rng.uniform(0.5, 30.0), 2) if not use_delta else None,
                "rationale": "Demo override: illustrative admin adjustment for testing, "
                "not a real projection change.",
                "effectiveAt": "2026-08-12T00:00:00Z",
                "expiresAt": None,
            }
        )
    return overrides


def build_dataset() -> dict[str, list[dict[str, Any]]]:
    keys = _KeySequence()
    teams = _build_teams()
    real_players, real_stats = _build_real_players_and_stats(keys)
    filler_players, filler_stats = _build_filler_players_and_stats(keys)
    players = real_players + filler_players
    season_stats = real_stats + filler_stats

    signal_rng = _rng_for("news-signals")
    signal_pool = [p for p in players if not p["isSyntheticFiller"]]

    return {
        "teams": teams,
        "players": players,
        "player_season_stats": season_stats,
        "adp_observations": _build_adp_observations(players),
        "news_signals": _build_news_signals(signal_pool, signal_rng),
        "projection_overrides_seed": _build_override_seeds(signal_pool, signal_rng),
    }


def write_dataset(out_dir: Path) -> dict[str, str]:
    dataset = build_dataset()
    checksums: dict[str, str] = {}
    for name, rows in dataset.items():
        filename = f"{name}.json"
        text = json.dumps(rows, indent=2, sort_keys=True) + "\n"
        (out_dir / filename).write_text(text, encoding="utf-8")
        checksums[filename] = hashlib.sha256(text.encode("utf-8")).hexdigest()

    manifest = {
        "datasetVersion": DATASET_VERSION,
        "seed": SEED,
        "generatedAt": GENERATED_AT,
        "disclaimer": DISCLAIMER,
        "files": checksums,
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return checksums


def verify_determinism() -> bool:
    """Runs generation twice into isolated temp dirs and compares every
    output file byte-for-byte. Returns True iff identical."""
    with tempfile.TemporaryDirectory() as tmp1, tempfile.TemporaryDirectory() as tmp2:
        checksums1 = write_dataset(Path(tmp1))
        checksums2 = write_dataset(Path(tmp2))
        return checksums1 == checksums2


if __name__ == "__main__":
    if "--verify" in sys.argv:
        ok = verify_determinism()
        print("deterministic: OK" if ok else "deterministic: MISMATCH")
        sys.exit(0 if ok else 1)

    written = write_dataset(OUT_DIR)
    for filename, checksum in sorted(written.items()):
        print(f"{filename}: {checksum}")
