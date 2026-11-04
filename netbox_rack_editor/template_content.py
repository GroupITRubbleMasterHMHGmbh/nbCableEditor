from django.urls import reverse
from django.utils.html import format_html
from netbox.plugins import PluginTemplateExtension


class RackLink(PluginTemplateExtension):
    models = ["dcim.rack"]

    def buttons(self):
        return format_html(
            '<a class="btn btn-outline-primary" href="{}">'
            '<i class="mdi mdi-connection" aria-hidden="true"></i> Cable editor</a>',
            reverse("plugins:netbox_rack_editor:rack", args=[self.context["object"].pk]),
        )


class LayoutLink(PluginTemplateExtension):
    models = ["dcim.devicetype", "dcim.moduletype"]

    def buttons(self):
        owner = self.context["object"]
        route = "module-layout" if owner._meta.model_name == "moduletype" else "layout"
        return format_html(
            '<a class="btn btn-outline-primary" href="{}">'
            '<i class="mdi mdi-crosshairs" aria-hidden="true"></i> Layout editor</a>',
            reverse(f"plugins:netbox_rack_editor:{route}", args=[owner.pk]),
        )


template_extensions = [RackLink, LayoutLink]
