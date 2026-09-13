"""Tiny notes service used as Mantyl's Python fixture.

Seeded quirks, mirroring examples/sample-project: an undocumented
environment variable (no .env.example exists) and a TODO the collector
should harvest.
"""

import os


def auth_token() -> str:
    return os.environ["API_TOKEN"]


def storage_dir() -> str:
    # TODO: persistence is still in-memory, wire the real storage backend
    return os.getenv("NOTES_STORAGE_DIR", "/tmp/notes")


def add_note(notes: list[str], text: str) -> list[str]:
    if not text.strip():
        raise ValueError("empty note")
    return [*notes, text.strip()]
