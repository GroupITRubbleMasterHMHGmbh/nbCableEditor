import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("netbox_rack_editor", "0002_cable_history"),
    ]
    operations = [
        migrations.AlterField(
            model_name="portplacement",
            name="interface_template",
            field=models.OneToOneField(
                to="dcim.interfacetemplate", on_delete=django.db.models.deletion.CASCADE,
                related_name="+", blank=True, null=True,
            ),
        ),
        migrations.AddField(
            model_name="portplacement",
            name="front_port_template",
            field=models.OneToOneField(
                to="dcim.frontporttemplate", on_delete=django.db.models.deletion.CASCADE,
                related_name="+", blank=True, null=True,
            ),
        ),
        migrations.AddField(
            model_name="portplacement",
            name="rear_port_template",
            field=models.OneToOneField(
                to="dcim.rearporttemplate", on_delete=django.db.models.deletion.CASCADE,
                related_name="+", blank=True, null=True,
            ),
        ),
        migrations.AddConstraint(
            model_name="portplacement",
            constraint=models.CheckConstraint(
                condition=(
                    models.Q(interface_template__isnull=False, front_port_template__isnull=True,
                             rear_port_template__isnull=True)
                    | models.Q(interface_template__isnull=True, front_port_template__isnull=False,
                               rear_port_template__isnull=True, face="front")
                    | models.Q(interface_template__isnull=True, front_port_template__isnull=True,
                               rear_port_template__isnull=False, face="rear")
                ),
                name="rack_editor_placement_template_face",
            ),
        ),
    ]
