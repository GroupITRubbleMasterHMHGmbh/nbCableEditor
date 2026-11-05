import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("nbcableeditor", "0004_vlan_editor_color"),
    ]

    operations = [
        migrations.AlterField(
            model_name="layoutrevision",
            name="device_type",
            field=models.OneToOneField(
                to="dcim.devicetype", on_delete=django.db.models.deletion.CASCADE,
                related_name="+", blank=True, null=True,
            ),
        ),
        migrations.AddField(
            model_name="layoutrevision",
            name="module_type",
            field=models.OneToOneField(
                to="dcim.moduletype", on_delete=django.db.models.deletion.CASCADE,
                related_name="+", blank=True, null=True,
            ),
        ),
        migrations.AddField(
            model_name="layoutrevision",
            name="design",
            field=models.JSONField(default=dict, blank=True),
        ),
        migrations.AddConstraint(
            model_name="layoutrevision",
            constraint=models.CheckConstraint(
                condition=(
                    models.Q(device_type__isnull=False, module_type__isnull=True)
                    | models.Q(device_type__isnull=True, module_type__isnull=False)
                ),
                name="nbcableeditor_layout_owner",
            ),
        ),
        migrations.AddField(
            model_name="portplacement",
            name="label",
            field=models.CharField(max_length=64, blank=True, default=""),
        ),
    ]
