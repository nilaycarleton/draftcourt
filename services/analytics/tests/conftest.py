import os

# Required settings must be present before `app.main` (or anything importing
# app.core.config.get_settings) is first imported by a test module.
os.environ.setdefault(
    "DATABASE_URL", "postgresql://draftcourt:draftcourt@localhost:5432/draftcourt_test"
)
os.environ.setdefault("SERVICE_SECRET", "test-secret")
