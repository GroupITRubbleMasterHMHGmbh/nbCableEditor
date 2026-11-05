import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models
from django.db.models.functions import Lower


class Migration(migrations.Migration):
    dependencies = [
        ("dcim", "0227_alter_interface_speed_bigint"),
        ("nbcableeditor", "0006_cable_editor_settings"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="RackCableGeometry",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False)),
                ("measurements", models.JSONField(blank=True, default=dict)),
                ("rack", models.OneToOneField(
                    on_delete=django.db.models.deletion.CASCADE, related_name="+", to="dcim.rack",
                )),
            ],
        ),
        migrations.CreateModel(
            name="RackCablePlan",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False)),
                ("name", models.CharField(max_length=120)),
                ("revision", models.PositiveBigIntegerField(default=0)),
                ("operations", models.JSONField(blank=True, default=list)),
                ("profile", models.JSONField(default=dict)),
                ("catalog", models.JSONField(default=dict)),
                ("result", models.JSONField(blank=True, default=dict)),
                ("created", models.DateTimeField(auto_now_add=True)),
                ("updated", models.DateTimeField(auto_now=True)),
                ("applied_at", models.DateTimeField(blank=True, null=True)),
                ("applied_by", models.ForeignKey(
                    blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                    related_name="+", to=settings.AUTH_USER_MODEL,
                )),
                ("rack", models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE, related_name="+", to="dcim.rack",
                )),
            ],
            options={
                "ordering": ("name", "pk"),
                "constraints": [
                    models.UniqueConstraint(Lower("name"), models.F("rack"), name="nbcableeditor_plan_rack_name"),
                ],
            },
        ),
    ]
