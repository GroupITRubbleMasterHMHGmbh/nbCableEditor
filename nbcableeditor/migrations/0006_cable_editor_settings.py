from django.db import migrations, models


def create_settings(apps, schema_editor):
    settings = apps.get_model("nbcableeditor", "CableEditorSettings")
    settings.objects.using(schema_editor.connection.alias).get_or_create(pk=1)


class Migration(migrations.Migration):
    dependencies = [("nbcableeditor", "0005_type_design")]

    operations = [
        migrations.CreateModel(
            name="CableEditorSettings",
            fields=[
                ("id", models.PositiveSmallIntegerField(default=1, editable=False, primary_key=True, serialize=False)),
                ("options", models.JSONField(blank=True, default=dict)),
            ],
            options={
                "verbose_name": "Cable Editor settings",
                "constraints": [
                    models.CheckConstraint(condition=models.Q(id=1), name="nbcableeditor_settings_singleton"),
                ],
            },
        ),
        migrations.RunPython(create_settings, migrations.RunPython.noop),
    ]
