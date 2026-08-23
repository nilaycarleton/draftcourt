"""Structured JSON logging configuration, per BUILD_SPEC.md section 19
(observability). Applied once at process startup via `configure_logging()`."""

import logging
import sys

from pythonjsonlogger.json import JsonFormatter


def configure_logging(level: int = logging.INFO) -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        JsonFormatter(
            "%(asctime)s %(levelname)s %(name)s %(message)s",
            rename_fields={"asctime": "timestamp", "levelname": "level", "name": "logger"},
        )
    )

    root_logger = logging.getLogger()
    root_logger.handlers = [handler]
    root_logger.setLevel(level)


__all__: list[str] = ["configure_logging"]
