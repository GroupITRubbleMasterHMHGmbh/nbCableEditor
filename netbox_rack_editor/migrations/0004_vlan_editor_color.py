from django.db import migrations


def add_vlan_editor_color(apps, schema_editor):
    database = schema_editor.connection.alias
    CustomField = apps.get_model("extras", "CustomField")
    ContentType = apps.get_model("contenttypes", "ContentType")
    field, _ = CustomField.objects.using(database).get_or_create(
        name="editorColorHex",
        defaults={
            "type": "text",
            "label": "Rack editor color",
            "description": "Untagged VLAN fill color in the Rack Cable Editor, for example #16A34A.",
            "validation_regex": r"\A#[0-9A-Fa-f]{6}\Z",
        },
    )
    if field.type != "text":
        return

    vlan_type, _ = ContentType.objects.using(database).get_or_create(app_label="ipam", model="vlan")
    field.object_types.add(vlan_type)


class Migration(migrations.Migration):
    dependencies = [
        ("netbox_rack_editor", "0003_passive_port_placements"),
        ("extras", "0134_owner"),
        ("ipam", "0086_gfk_indexes"),
    ]

    # Keep existing VLAN colors and administrator settings on a plugin rollback.
    operations = [migrations.RunPython(add_vlan_editor_color, migrations.RunPython.noop)]
