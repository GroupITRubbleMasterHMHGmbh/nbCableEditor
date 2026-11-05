from django.contrib.contenttypes.models import ContentType
from django.db.models import Q

from extras.models import Tag


class TagEditError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def available_tags(db, user, model):
    content_type = ContentType.objects.db_manager(db).get_for_model(model)
    return Tag.objects.using(db).restrict(user).filter(
        Q(object_types__isnull=True) | Q(object_types=content_type),
    )


def tag_data(tag):
    return {"id": tag.pk, "name": tag.name, "color": tag.color}


def visible_tags(db, user, obj):
    assigned = obj.tags.using(db).values("pk")
    return [tag_data(tag) for tag in available_tags(db, user, type(obj)).filter(pk__in=assigned)]


def _tag_ids(value):
    if not isinstance(value, list) or any(type(pk) is not int or not 0 < pk < 2**63 for pk in value):
        raise TagEditError("Send tag IDs as a list of positive integers.")
    return set(value)


def updated_tags(db, user, obj, ids, *, expected=None):
    requested = _tag_ids(ids)
    current = {tag.pk: tag for tag in obj.tags.using(db).all()}
    permitted = {
        tag.pk: tag for tag in available_tags(db, user, type(obj)).filter(pk__in=requested | current.keys())
    }
    if requested - permitted.keys():
        raise TagEditError("One or more selected tags are unavailable for this object.")
    if expected is not None and _tag_ids(expected) != current.keys() & permitted.keys():
        raise TagEditError("The assigned tags changed. Reload the rack and try again.", 409)

    # The editor can replace only the visible, applicable subset of the assignment.
    return [permitted[pk] for pk in sorted(requested)] + [tag for pk, tag in current.items() if pk not in permitted]
