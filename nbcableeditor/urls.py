from django.urls import path

from . import cable_views, layout_catalog, plan_views, port_views, views
from .configuration import editor_settings


urlpatterns = [
    path("settings/", editor_settings, name="settings"),
    path("racks/<int:pk>/", views.rack_editor, name="rack"),
    path("racks/<int:pk>/cables/", cable_views.mutate_cable, name="cables"),
    path("racks/<int:pk>/ports/", port_views.mutate_port, name="ports"),
    path("racks/<int:pk>/plans/", plan_views.rack_plans, name="plans"),
    path("racks/<int:pk>/plans/<int:plan_id>/", plan_views.rack_plan, name="plan"),
    path("racks/<int:pk>/calculator/", plan_views.rack_calculator, name="calculator"),
    path("device-types/import/", layout_catalog.layout_imports, name="layout-imports"),
    path("device-types/<int:pk>/", views.layout_editor, name="layout"),
    path("device-types/<int:pk>/placements/", views.save_layout, name="placements"),
    path("module-types/<int:pk>/", views.layout_editor, {"kind": "module"}, name="module-layout"),
    path("module-types/<int:pk>/placements/", views.save_layout, {"kind": "module"}, name="module-placements"),
]
