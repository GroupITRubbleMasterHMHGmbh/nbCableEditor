import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True
    dependencies = [
        ("dcim", "0227_alter_interface_speed_bigint"),
    ]
    operations = [
        migrations.CreateModel(
            name="LayoutRevision",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("revision", models.PositiveBigIntegerField(default=0)),
                ("device_type", models.OneToOneField(
                    on_delete=django.db.models.deletion.CASCADE, related_name="+", to="dcim.devicetype"
                )),
            ],
        ),
        migrations.CreateModel(
            name="PortPlacement",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("face", models.CharField(choices=[("front", "Front"), ("rear", "Rear")], max_length=5)),
                ("x", models.FloatField()),
                ("y", models.FloatField()),
                ("interface_template", models.OneToOneField(
                    on_delete=django.db.models.deletion.CASCADE, related_name="+", to="dcim.interfacetemplate"
                )),
            ],
            options={
                "constraints": [
                    models.CheckConstraint(
                        condition=models.Q(("face__in", ("front", "rear")), ("x__gte", 0), ("x__lte", 1),
                                           ("y__gte", 0), ("y__lte", 1)),
                        name="nbcableeditor_valid_placement",
                    )
                ],
            },
        ),
    ]
