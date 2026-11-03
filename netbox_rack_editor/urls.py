from django.urls import path

from . import cable_views, views


urlpatterns = [
    path("racks/<int:pk>/", views.rack_editor, name="rack"),
    path("racks/<int:pk>/cables/", cable_views.mutate_cable, name="cables"),
    path("device-types/<int:pk>/", views.layout_editor, name="layout"),
    path("device-types/<int:pk>/placements/", views.save_layout, name="placements"),
]
