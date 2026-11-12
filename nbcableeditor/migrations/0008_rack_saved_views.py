import django.db.models.deletion
from django.db import migrations, models
from django.db.models.functions import Lower


class Migration(migrations.Migration):
    dependencies = [
        ("nbcableeditor", "0007_rack_planning"),
    ]

    operations = [
        migrations.CreateModel(
            name="RackSavedView",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False)),
                ("name", models.CharField(max_length=120)),
                ("settings", models.JSONField(default=dict)),
                ("is_default", models.BooleanField(default=False)),
                ("revision", models.PositiveBigIntegerField(default=0)),
                ("rack", models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE, related_name="+", to="dcim.rack",
                )),
            ],
            options={
                "ordering": (Lower("name"), "pk"),
                "constraints": [
                    models.UniqueConstraint(Lower("name"), models.F("rack"), name="nbcableeditor_view_rack_name"),
                    models.UniqueConstraint(
                        fields=("rack",), condition=models.Q(is_default=True), name="nbcableeditor_view_rack_default",
                    ),
                ],
            },
        ),
    ]
