"""Mirrors packages/domain/src/enums.ts. Keep both files in sync manually
until a future phase automates Python generation from the JSON Schema in
data/schemas/."""

from enum import StrEnum


class UserRole(StrEnum):
    USER = "USER"
    ADMIN = "ADMIN"


class LeagueType(StrEnum):
    POINTS = "POINTS"
    CATEGORIES = "CATEGORIES"


class LeagueHorizon(StrEnum):
    REDRAFT = "REDRAFT"
    KEEPER = "KEEPER"
    DYNASTY = "DYNASTY"


class DraftType(StrEnum):
    REAL = "REAL"
    MOCK = "MOCK"
    DEMO = "DEMO"


class DraftStatus(StrEnum):
    SETUP = "SETUP"
    ACTIVE = "ACTIVE"
    PAUSED = "PAUSED"
    COMPLETED = "COMPLETED"
    ABANDONED = "ABANDONED"


class DraftEventType(StrEnum):
    DRAFT_STARTED = "DRAFT_STARTED"
    PLAYER_DRAFTED = "PLAYER_DRAFTED"
    PICK_UNDONE = "PICK_UNDONE"
    DRAFT_PAUSED = "DRAFT_PAUSED"
    DRAFT_RESUMED = "DRAFT_RESUMED"
    DRAFT_COMPLETED = "DRAFT_COMPLETED"


class Position(StrEnum):
    PG = "PG"
    SG = "SG"
    SF = "SF"
    PF = "PF"
    C = "C"
    G = "G"
    F = "F"
    UTIL = "UTIL"
    BENCH = "BENCH"


class Direction(StrEnum):
    HIGHER_BETTER = "HIGHER_BETTER"
    LOWER_BETTER = "LOWER_BETTER"


class Availability(StrEnum):
    ACTIVE = "ACTIVE"
    INJURED = "INJURED"
    SUSPENDED = "SUSPENDED"
    UNSIGNED = "UNSIGNED"
    RETIRED = "RETIRED"


class PreferenceListType(StrEnum):
    FAVORITE = "FAVORITE"
    DISLIKED = "DISLIKED"
    TARGET = "TARGET"
    AVOID = "AVOID"


# Phase 1 enums (BUILD_SPEC.md section 4.2 data model + Phase 1 additions —
# see docs/adr/0005-phase1-data-model.md). Mirrored in
# packages/domain/src/enums.ts and packages/db/prisma/schema.prisma.


class EligiblePosition(StrEnum):
    PG = "PG"
    SG = "SG"
    SF = "SF"
    PF = "PF"
    C = "C"
    G = "G"
    F = "F"


class StatScope(StrEnum):
    NBA = "NBA"
    COLLEGE = "COLLEGE"
    INTERNATIONAL = "INTERNATIONAL"


class SourceAdapterType(StrEnum):
    FILE = "FILE"
    API = "API"


class IngestionRunStatus(StrEnum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    PARTIAL = "PARTIAL"


class RawRecordStatus(StrEnum):
    PENDING = "PENDING"
    VALIDATED = "VALIDATED"
    QUARANTINED = "QUARANTINED"
    PUBLISHED = "PUBLISHED"


class IdentityMatchStatus(StrEnum):
    CONFIRMED = "CONFIRMED"
    CANDIDATE = "CANDIDATE"
    REJECTED = "REJECTED"


class IdentityMatchMethod(StrEnum):
    PROVIDER_ID = "PROVIDER_ID"
    NAME_DOB = "NAME_DOB"
    MANUAL = "MANUAL"


class SignalType(StrEnum):
    INJURY = "INJURY"
    TRADE = "TRADE"
    STARTER_CHANGE = "STARTER_CHANGE"
    ROLE_UP = "ROLE_UP"
    ROLE_DOWN = "ROLE_DOWN"


class OverrideStatus(StrEnum):
    ACTIVE = "ACTIVE"
    EXPIRED = "EXPIRED"
    SUPERSEDED = "SUPERSEDED"
    REVOKED = "REVOKED"


class ProjectionModelStatus(StrEnum):
    DRAFT = "DRAFT"
    ACTIVE = "ACTIVE"
    DEPRECATED = "DEPRECATED"
    ARCHIVED = "ARCHIVED"


class ProjectionRunStatus(StrEnum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
