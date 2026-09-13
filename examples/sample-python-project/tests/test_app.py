import pytest

from app import add_note


def test_add_note_strips_and_appends():
    assert add_note(["a"], " b ") == ["a", "b"]


def test_add_note_rejects_empty():
    with pytest.raises(ValueError):
        add_note([], "   ")
