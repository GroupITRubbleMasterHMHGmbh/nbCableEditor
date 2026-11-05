from django.urls import path

from . import cable_views, layout_catalog, port_views, views
from .configuration import editor_settings


urlpatterns = [
    path("settings/", editor_settings, name="settings"),
    path("racks/<int:pk>/", views.rack_editor, name="rack"),
    path("racks/<int:pk>/cables/", cable_views.mutate_cable, name="cables"),
    path("racks/<int:pk>/ports/", port_views.mutate_port, name="ports"),
    path("device-types/import/", layout_catalog.layout_imports, name="layout-imports"),
    path("device-types/<int:pk>/", views.layout_editor, name="layout"),
    path("device-types/<int:pk>/placements/", views.save_layout, name="placements"),
    path("module-types/<int:pk>/", views.layout_editor, {"kind": "module"}, name="module-layout"),
    path("module-types/<int:pk>/placements/", views.save_layout, {"kind": "module"}, name="module-placements"),
]
