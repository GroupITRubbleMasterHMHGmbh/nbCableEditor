import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("nbcableeditor", "0001_initial"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]
    operations = [
        migrations.CreateModel(
            name="CableHistoryJournal",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("cursor", models.PositiveBigIntegerField(default=0)),
                ("revision", models.PositiveBigIntegerField(default=0)),
                ("rack", models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE, related_name="+", to="dcim.rack"
                )),
                ("user", models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE, related_name="+", to=settings.AUTH_USER_MODEL
                )),
            ],
            options={
                "constraints": [
                    models.UniqueConstraint(fields=("rack", "user"), name="nbcableeditor_history_rack_user"),
                ],
            },
        ),
        migrations.CreateModel(
            name="CableHistoryEntry",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("sequence", models.PositiveBigIntegerField()),
                ("label", models.CharField(max_length=255)),
                ("created", models.DateTimeField(auto_now_add=True)),
                ("changes", models.JSONField()),
                ("journal", models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE, related_name="entries",
                    to="nbcableeditor.cablehistoryjournal",
                )),
            ],
            options={
                "constraints": [
                    models.UniqueConstraint(fields=("journal", "sequence"), name="nbcableeditor_history_sequence"),
                    models.CheckConstraint(
                        condition=models.Q(sequence__gte=1), name="nbcableeditor_history_positive_sequence"
                    ),
                ],
            },
        ),
    ]
