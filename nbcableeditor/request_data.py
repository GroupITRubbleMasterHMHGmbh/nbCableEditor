import json
import math
import re

from django.conf import settings
from django.http import UnreadablePostError


MAX_JSON_BYTES = 512 * 1024
INVALID_TEXT = re.compile(r"[\x00\ud800-\udfff]")


class JsonRequestError(ValueError):
    def __init__(self, message, status):
        super().__init__(message)
        self.status = status


def _object(pairs):
    result = dict(pairs)
    if len(result) != len(pairs):
        raise ValueError("Duplicate JSON property.")
    return result


def _invalid_constant(value):
    raise ValueError(f"Invalid JSON constant: {value}")


def _finite_float(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("JSON number is out of range.")
    return number


def _validate_text(data):
    # Decoding UTF-8 alone cannot reject NUL and lone surrogates written as JSON escapes.
    pending = [data]
    while pending:
        value = pending.pop()
        if isinstance(value, dict):
            pending.extend(value)
            pending.extend(value.values())
        elif isinstance(value, list):
            pending.extend(value)
        elif isinstance(value, str) and INVALID_TEXT.search(value):
            raise ValueError("Invalid JSON character.")


def read_json_object(request):
    if request.content_type != "application/json":
        raise JsonRequestError("Send an application/json request.", 415)

    max_bytes = MAX_JSON_BYTES
    if settings.DATA_UPLOAD_MAX_MEMORY_SIZE is not None:
        max_bytes = min(max_bytes, settings.DATA_UPLOAD_MAX_MEMORY_SIZE)
    try:
        # Read only the bytes we can accept even if the client omits Content-Length.
        raw = request.read(max_bytes + 1)
    except UnreadablePostError as exc:
        raise JsonRequestError("Could not read the JSON request.", 400) from exc
    if len(raw) > max_bytes:
        raise JsonRequestError("The JSON request is too large.", 413)

    try:
        data = json.loads(raw.decode("utf-8"), object_pairs_hook=_object,
                          parse_float=_finite_float, parse_constant=_invalid_constant)
        _validate_text(data)
    except (ValueError, RecursionError) as exc:
        raise JsonRequestError("Invalid JSON request.", 400) from exc
    if not isinstance(data, dict):
        raise JsonRequestError("Send a JSON object.", 400)
    return data
