from netbox.plugins import PluginConfig


class RackEditorConfig(PluginConfig):
    name = "netbox_rack_editor"
    verbose_name = "Rack Cable Editor"
    description = "Place ports on device images and connect them in a rack."
    version = "0.10.9"
    base_url = "rack-editor"
    min_version = "4.5.10"
    max_version = "4.5.99"


config = RackEditorConfig
