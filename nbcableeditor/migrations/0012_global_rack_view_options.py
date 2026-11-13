from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("nbcableeditor", "0011_favorite_rack"),
    ]

    operations = [
        migrations.AddField(
            model_name="globalracksavedview",
            name="show_in_toolbar",
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name="globalracksavedview",
            name="is_default",
            field=models.BooleanField(default=False),
        ),
    ]
