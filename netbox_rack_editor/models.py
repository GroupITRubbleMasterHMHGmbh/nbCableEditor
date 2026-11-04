from django.conf import settings
from django.db import models
from django.db.models import Q


class LayoutRevision(models.Model):
    device_type = models.OneToOneField(
        "dcim.DeviceType", on_delete=models.CASCADE, related_name="+", blank=True, null=True,
    )
    module_type = models.OneToOneField(
        "dcim.ModuleType", on_delete=models.CASCADE, related_name="+", blank=True, null=True,
    )
    revision = models.PositiveBigIntegerField(default=0)
    design = models.JSONField(default=dict, blank=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=(
                    Q(device_type__isnull=False, module_type__isnull=True)
                    | Q(device_type__isnull=True, module_type__isnull=False)
                ),
                name="rack_editor_layout_owner",
            ),
        ]


class PortPlacement(models.Model):
    class Face(models.TextChoices):
        FRONT = "front", "Front"
        REAR = "rear", "Rear"

    interface_template = models.OneToOneField(
        "dcim.InterfaceTemplate", on_delete=models.CASCADE, related_name="+", blank=True, null=True
    )
    front_port_template = models.OneToOneField(
        "dcim.FrontPortTemplate", on_delete=models.CASCADE, related_name="+", blank=True, null=True
    )
    rear_port_template = models.OneToOneField(
        "dcim.RearPortTemplate", on_delete=models.CASCADE, related_name="+", blank=True, null=True
    )
    face = models.CharField(max_length=5, choices=Face.choices)
    x = models.FloatField()
    y = models.FloatField()
    label = models.CharField(max_length=64, blank=True, default="")

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=Q(face__in=("front", "rear"), x__gte=0, x__lte=1, y__gte=0, y__lte=1),
                name="rack_editor_valid_placement",
            ),
            models.CheckConstraint(
                condition=(
                    Q(interface_template__isnull=False, front_port_template__isnull=True, rear_port_template__isnull=True)
                    | Q(interface_template__isnull=True, front_port_template__isnull=False,
                        rear_port_template__isnull=True, face="front")
                    | Q(interface_template__isnull=True, front_port_template__isnull=True,
                        rear_port_template__isnull=False, face="rear")
                ),
                name="rack_editor_placement_template_face",
            ),
        ]


class CableHistoryJournal(models.Model):
    rack = models.ForeignKey("dcim.Rack", on_delete=models.CASCADE, related_name="+")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    cursor = models.PositiveBigIntegerField(default=0)
    revision = models.PositiveBigIntegerField(default=0)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=("rack", "user"), name="rack_editor_history_rack_user"),
        ]


class CableHistoryEntry(models.Model):
    journal = models.ForeignKey(CableHistoryJournal, on_delete=models.CASCADE, related_name="entries")
    sequence = models.PositiveBigIntegerField()
    label = models.CharField(max_length=255)
    created = models.DateTimeField(auto_now_add=True)
    changes = models.JSONField()

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=("journal", "sequence"), name="rack_editor_history_sequence"),
            models.CheckConstraint(condition=Q(sequence__gte=1), name="rack_editor_history_positive_sequence"),
        ]
