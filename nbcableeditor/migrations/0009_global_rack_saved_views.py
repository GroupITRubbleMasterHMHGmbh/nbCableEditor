from django.db import migrations, models
from django.db.models.functions import Lower


class Migration(migrations.Migration):
    dependencies = [
        ("nbcableeditor", "0008_rack_saved_views"),
    ]

    operations = [
        migrations.CreateModel(
            name="GlobalRackSavedView",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("name", models.CharField(max_length=120)),
                ("settings", models.JSONField(default=dict)),
                ("revision", models.PositiveBigIntegerField(default=0)),
                ("all_racks", models.BooleanField(default=False)),
                ("sites", models.ManyToManyField(blank=True, related_name="+", to="dcim.site")),
                ("racks", models.ManyToManyField(blank=True, related_name="+", to="dcim.rack")),
                ("roles", models.ManyToManyField(blank=True, related_name="+", to="dcim.rackrole")),
                ("tags", models.ManyToManyField(blank=True, related_name="+", to="extras.tag")),
            ],
            options={
                "ordering": (Lower("name"), "pk"),
                "constraints": [models.UniqueConstraint(Lower("name"), name="nbcableeditor_global_view_name")],
            },
        ),
    ]
