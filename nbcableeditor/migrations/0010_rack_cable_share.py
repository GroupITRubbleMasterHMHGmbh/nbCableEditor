import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("nbcableeditor", "0009_global_rack_saved_views")]

    operations = [
        migrations.CreateModel(
            name="RackCableShare",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("token", models.UUIDField(default=uuid.uuid4, editable=False, unique=True)),
                ("fingerprint", models.CharField(max_length=64)),
                ("settings", models.JSONField()),
                ("rack", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="+", to="dcim.rack")),
                ("cable", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="+", to="dcim.cable")),
            ],
            options={"constraints": [
                models.UniqueConstraint(fields=("rack", "cable", "fingerprint"), name="nbcableeditor_cable_share_settings"),
            ]},
        ),
    ]
