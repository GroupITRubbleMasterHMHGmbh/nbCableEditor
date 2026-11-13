import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("nbcableeditor", "0010_rack_cable_share"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="FavoriteRack",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("view_key", models.CharField(default="default", max_length=32)),
                ("user", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="+",
                                           to=settings.AUTH_USER_MODEL)),
                ("rack", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="+", to="dcim.rack")),
            ],
            options={"constraints": [
                models.UniqueConstraint(fields=("user", "rack"), name="nbcableeditor_favorite_user_rack"),
            ]},
        ),
    ]
