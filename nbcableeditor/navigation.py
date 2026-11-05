from netbox.plugins import PluginMenu, PluginMenuItem

from . import NbCableEditorConfig


menu = PluginMenu(
    label=NbCableEditorConfig.verbose_name,
    icon_class="mdi mdi-connection",
    groups=(("Configuration", (
        PluginMenuItem(
            link="plugins:nbcableeditor:settings",
            link_text="Settings",
            permissions=("nbcableeditor.change_cableeditorsettings",),
        ),
        PluginMenuItem(
            link="plugins:nbcableeditor:layout-imports",
            link_text="Layout template import",
            permissions=("dcim.view_devicetype", "dcim.change_devicetype"),
        ),
    )),),
)
