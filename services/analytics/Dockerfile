FROM python:3.12.5-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:0.12.5 /uv /uvx /usr/local/bin/

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY app ./app

RUN uv sync --frozen --no-dev

# No network access at container start — everything needed is already
# baked into .venv from the `uv sync` layers above.
ENV UV_NO_SYNC=1

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD uv run python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health/live', timeout=3)"

CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
