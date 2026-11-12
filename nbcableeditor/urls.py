from functools import wraps

from django.conf import settings
from django.contrib.auth.decorators import login_required
from django.urls import path
from django.views.decorators.cache import never_cache

from . import cable_views, layout_catalog, plan_views, port_views, views
from .configuration import editor_settings


def _editor_path(route, view, kwargs=None, *, name):
    authenticated_view = login_required(view)

    @never_cache
    @wraps(view)
    def dispatch(request, *args, **kwargs):
        if settings.LOGIN_REQUIRED:
            return authenticated_view(request, *args, **kwargs)
        return view(request, *args, **kwargs)

    return path(route, dispatch, kwargs, name=name)


urlpatterns = [
    _editor_path("settings/", editor_settings, name="settings"),
    _editor_path("racks/<int:pk>/", views.rack_editor, name="rack"),
    _editor_path("racks/<int:pk>/cables/", cable_views.mutate_cable, name="cables"),
    _editor_path("racks/<int:pk>/ports/", port_views.mutate_port, name="ports"),
    _editor_path("racks/<int:pk>/plans/", plan_views.rack_plans, name="plans"),
    _editor_path("racks/<int:pk>/plans/<int:plan_id>/", plan_views.rack_plan, name="plan"),
    _editor_path("racks/<int:pk>/calculator/", plan_views.rack_calculator, name="calculator"),
    _editor_path("device-types/import/", layout_catalog.layout_imports, name="layout-imports"),
    _editor_path("device-types/<int:pk>/", views.layout_editor, name="layout"),
    _editor_path("device-types/<int:pk>/placements/", views.save_layout, name="placements"),
    _editor_path("module-types/<int:pk>/", views.layout_editor, {"kind": "module"}, name="module-layout"),
    _editor_path("module-types/<int:pk>/placements/", views.save_layout, {"kind": "module"}, name="module-placements"),
]
