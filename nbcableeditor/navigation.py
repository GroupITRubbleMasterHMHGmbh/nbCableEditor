from netbox.plugins import PluginMenu, PluginMenuItem

from . import NbCableEditorConfig


menu = PluginMenu(
    label=NbCableEditorConfig.verbose_name,
    icon_class="mdi mdi-connection",
    groups=(("Racks", (
        PluginMenuItem(
            link="plugins:nbcableeditor:my-racks",
            link_text="My Rack list",
            permissions=("dcim.view_rack",),
        ),
    )), ("Configuration", (
        PluginMenuItem(
            link="plugins:nbcableeditor:settings",
            link_text="Settings",
            permissions=("nbcableeditor.change_cableeditorsettings",),
        ),
        PluginMenuItem(
            link="plugins:nbcableeditor:global-views",
            link_text="Global rack views",
            permissions=("nbcableeditor.change_cableeditorsettings",),
        ),
        PluginMenuItem(
            link="plugins:nbcableeditor:layout-imports",
            link_text="Layout template import",
            permissions=("dcim.view_devicetype", "dcim.change_devicetype"),
        ),
    ))),
)
