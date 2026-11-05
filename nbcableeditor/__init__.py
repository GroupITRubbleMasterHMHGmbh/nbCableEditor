from netbox.plugins import PluginConfig


class NbCableEditorConfig(PluginConfig):
    name = "nbcableeditor"
    verbose_name = "Cable Editor"
    description = "Place ports on device images and connect them in a rack."
    version = "0.10.61"
    base_url = "nbcableeditor"
    min_version = "4.5.10"
    max_version = "4.5.99"


config = NbCableEditorConfig
