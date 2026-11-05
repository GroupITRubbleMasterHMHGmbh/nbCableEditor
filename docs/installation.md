# Install nbCableEditor

nbCableEditor requires an existing NetBox 4.5 installation at version **4.5.10 or later** and **Python 3.12 or later** in the NetBox environment. The Python distribution is `nbCableEditor`. Add `nbcableeditor` in the NetBox configuration to enable **Cable Editor** under `/plugins/nbcableeditor/`.

## Install on an existing NetBox instance

These commands assume NetBox is installed under `/opt/netbox`. Adjust the paths for your instance. Back up the database before making changes to a production instance.

1. Copy this repository to the NetBox host and install the package using NetBox's Python interpreter.

   ```sh
   /opt/netbox/venv/bin/python -m pip install /path/to/nbCableEditor
   ```

   You can also pass a locally built wheel to `pip install`.

2. Add `"nbcableeditor"` to the existing `PLUGINS` list in the active `configuration.py`.

   ```python
   PLUGINS = [
       # Keep any existing plugins here.
       "nbcableeditor",
   ]
   ```

3. Apply the migrations, collect the static assets, and check the plugin's migration status.

   ```sh
   cd /opt/netbox/netbox
   /opt/netbox/venv/bin/python manage.py migrate
   /opt/netbox/venv/bin/python manage.py collectstatic --no-input
   /opt/netbox/venv/bin/python manage.py showmigrations nbcableeditor
   ```

4. Restart NetBox and its workers. On a standard systemd installation, run `sudo systemctl restart netbox netbox-rq`. Then open **Cable Editor** from a rack and **Layout editor** from a device type or module type.

If you use NetBox's `upgrade.sh` workflow, add a persistent path to the plugin package to `/opt/netbox/local_requirements.txt`. This makes the plugin available when an upgrade recreates the virtual environment. [NetBox 4.5.10 plugin installation guide](https://github.com/netbox-community/netbox/blob/v4.5.10/docs/plugins/installation.md) · [NetBox 4.5.10 upgrade guide](https://github.com/netbox-community/netbox/blob/v4.5.10/docs/installation/upgrading.md)

## Install on an existing NetBox Docker deployment

Build the plugin into a custom image and use that image for both the NetBox web service and its workers. The Compose file under `dev/` runs the local demo.

1. Place the `nbCableEditor` directory in the build context of your NetBox Docker deployment. Use the following example in your Dockerfile. Choose a supported NetBox base image that matches your Compose configuration. The demo uses the image shown here.

   ```dockerfile
   FROM ghcr.io/netbox-community/netbox:v4.5.10
   COPY ./nbCableEditor/pyproject.toml ./nbCableEditor/README.md /tmp/nbCableEditor/
   COPY ./nbCableEditor/nbcableeditor/ /tmp/nbCableEditor/nbcableeditor/
   RUN /usr/local/bin/uv pip install --python /opt/netbox/venv/bin/python /tmp/nbCableEditor
   ```

2. Add `"nbcableeditor"` to the `PLUGINS` list loaded by the containers. NetBox Docker typically uses `configuration/plugins.py`.
3. Build the image and run `collectstatic --no-input` with the plugin enabled. The official NetBox Docker workflow includes this step in the Dockerfile. If your deployment mounts a separate volume for static assets, collect the files into that volume.
4. Deploy the web service and workers with the new image. Run `manage.py migrate` against the deployment's database before using the editor. Then verify that both editor buttons open the expected screens in NetBox. [NetBox Docker guide to custom images, plugin configuration, and static assets](https://github.com/netbox-community/netbox-docker/wiki/Using-Netbox-Plugins)

## Upgrade the plugin

1. Back up the database and check that the new plugin release supports your NetBox version.
2. For a Python installation, install the new source or wheel with `/opt/netbox/venv/bin/python -m pip install --upgrade /path/to/nbCableEditor`. For Docker, rebuild the image with the new plugin release and deploy it to the web service and workers.
3. Apply the migrations and collect the static assets again. Keep the existing plugin configuration.
4. Restart NetBox and its workers, or recreate the containers. Open a rack and device type with existing data to check that cables and port positions appear as expected.

## Configure VLAN colors

The migration adds the optional text field `editorColorHex` to the NetBox **IPAM → VLAN** object type. Open a VLAN and enter a hex color such as `#16A34A` under **Edit → Cable Editor color**. Each VLAN object has its own color, including when the same VLAN ID appears in several groups. Rolling back the plugin migration preserves the field and its values.

The migration reuses an existing text field with this internal name for VLANs. It updates the shipped label and description to match the new branding and preserves customized values. If a field of another type already uses the name, the migration leaves that field untouched.

## Permissions

The editor respects NetBox object permissions and any object filters.

| Task | Required NetBox permissions |
| --- | --- |
| View the rack | **View** on the rack, visible devices, and their ports. The device model in connection details and the layout link in the interface directory also require **View** on the corresponding device type. |
| View cables and VLAN data | **View** on the relevant cables and VLANs. A cable trace shows the points the user has permission to view. |
| View a port layout | **View** on the device type or module type and on the interface, front port, rear port, and module bay templates it uses. |
| Save a port layout | Also requires **Change** on the device type or module type. |
| Review and import a built-in device type template | **View** and **Change** on the corresponding device type, plus the template-component permissions needed by the layout editor. |
| Change global editor settings | Superuser or **Change** on the **Cable Editor → Cable Editor settings** object type. Settings are shared across the NetBox instance. |
| View installed modules in the rack | **View** on module bays, module bay templates, modules, and module types. Module type images also require **View** on the relevant image attachments. |
| Create, move, or delete a cable | **Add**, **Change**, or **Delete** on the native NetBox cable object, according to the action. The user also needs access to the devices and ports at both ends. |
| Restore a history entry | The permissions required for the corresponding cable operations. History is stored per user and rack. |

## Troubleshooting

- **NetBox cannot import the plugin.** Check that the package is installed in the NetBox Python environment and that `PLUGINS` contains `nbcableeditor`.
- **An editor button is missing or changes do not appear.** Check the active plugin configuration and installed package version. Verify that both the web service and workers load the new version.
- **The editor loads without its interface.** Verify the migrations and `collectstatic` step, then check that the web server serves the collected assets.
- **A device image or port is missing.** Check the device type, the image for the selected face, the port position, and the user's view permissions. Check the current visibility settings under **View** and **Port rows**.
