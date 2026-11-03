# Rack Cable Editor installieren

Eine bestehende NetBox-Instanz ab **4.5.10** innerhalb der **4.5-Reihe** und mindestens **Python 3.12** im NetBox-Environment sind erforderlich. Das Paket heißt `netbox-rack-editor`, das Plugin in der NetBox-Konfiguration `netbox_rack_editor`.

## Bestehende Python-Installation

Die Befehle zeigen eine NetBox-Installation unter `/opt/netbox`. Die Pfade an die eigene Instanz anpassen. Vor Änderungen an einer produktiven Instanz die Datenbank sichern.

1. Dieses Repository auf den NetBox-Host kopieren und das Paket mit dem Python-Interpreter von NetBox installieren.

   ```sh
   /opt/netbox/venv/bin/python -m pip install /pfad/zu/nbCableEditor
   ```

   Ein lokal gebautes Wheel kann anstelle des Quellordners übergeben werden.

2. In der aktiven `configuration.py` den Eintrag `"netbox_rack_editor"` zur bestehenden Liste `PLUGINS` hinzufügen.

   ```python
   PLUGINS = [
       # Weitere vorhandene Plugins hier beibehalten.
       "netbox_rack_editor",
   ]
   ```

3. Migrationen anwenden und die statischen Dateien für die Oberfläche bereitstellen.

   ```sh
   cd /opt/netbox/netbox
   /opt/netbox/venv/bin/python manage.py migrate
   /opt/netbox/venv/bin/python manage.py collectstatic --no-input
   /opt/netbox/venv/bin/python manage.py showmigrations netbox_rack_editor
   ```

4. NetBox und seine Worker neu starten. Bei einer Standardinstallation mit systemd lautet der Befehl `sudo systemctl restart netbox netbox-rq`. Anschließend an einem Rack **Cable editor** und an einem Gerätetyp **Port layout** öffnen.

Bei einem späteren NetBox-Upgrade mit `upgrade.sh` muss das Plugin erneut verfügbar sein, wenn das virtuelle Environment neu erstellt wird. Einen dauerhaften Pfad zum Plugin-Paket in der lokalen Abhängigkeitsliste `/opt/netbox/local_requirements.txt` hinterlegen, sofern diese Installation den NetBox-Upgrade-Workflow verwendet. [NetBox 4.5.10 · Plugins installieren](https://github.com/netbox-community/netbox/blob/v4.5.10/docs/plugins/installation.md) · [NetBox 4.5.10 · Upgrade](https://github.com/netbox-community/netbox/blob/v4.5.10/docs/installation/upgrading.md)

## Bestehendes NetBox Docker

Das Plugin in ein eigenes Image aufnehmen und dasselbe Image für die NetBox-Webinstanz und ihre Worker verwenden. Die Compose-Datei unter `dev/` dient der lokalen Demo.

1. Den Ordner `nbCableEditor` im Build-Kontext der bestehenden NetBox-Docker-Installation bereitstellen. Den folgenden Ausschnitt in das eigene Dockerfile übernehmen. Die `FROM`-Zeile zeigt das Basisimage der Demo als Beispiel. Bei einer bestehenden Installation das zur Compose-Konfiguration passende Image innerhalb der unterstützten NetBox-Versionen verwenden.

   ```dockerfile
   FROM ghcr.io/netbox-community/netbox:v4.5.10
   COPY ./nbCableEditor/pyproject.toml ./nbCableEditor/README.md /tmp/nbCableEditor/
   COPY ./nbCableEditor/netbox_rack_editor/ /tmp/nbCableEditor/netbox_rack_editor/
   RUN /usr/local/bin/uv pip install --python /opt/netbox/venv/bin/python /tmp/nbCableEditor
   ```

2. `"netbox_rack_editor"` in der von den Containern geladenen Liste `PLUGINS` ergänzen, bei NetBox Docker üblicherweise in `configuration/plugins.py`.
3. Das Image bauen und die Plugin-Assets mit aktivierter Plugin-Konfiguration per `collectstatic --no-input` in den statischen Pfad der Bereitstellung übernehmen. Beim offiziellen NetBox-Docker-Ablauf wird dieser Schritt in das Dockerfile aufgenommen. Falls der statische Pfad als eigenes Volume eingebunden ist, die Dateien in diesem Volume bereitstellen.
4. Webinstanz und Worker mit dem neuen Image bereitstellen. `manage.py migrate` muss gegen die Datenbank dieser Instanz gelaufen sein, bevor der Editor genutzt wird. Anschließend die beiden Editor-Schaltflächen und ihre Oberfläche in NetBox prüfen. [NetBox Docker · Eigenes Image, Plugin-Konfiguration und collectstatic](https://github.com/netbox-community/netbox-docker/wiki/Using-Netbox-Plugins)

## Plugin aktualisieren

1. Datenbank sichern und prüfen, ob die NetBox-Version von der neuen Plugin-Ausgabe unterstützt wird.
2. Bei einer Python-Installation die neue Quelle oder das neue Wheel mit `/opt/netbox/venv/bin/python -m pip install --upgrade /pfad/zu/nbCableEditor` installieren. Bei Docker das Image mit der neuen Plugin-Ausgabe neu bauen und für Webinstanz und Worker ausrollen.
3. Migrationen erneut anwenden und statische Dateien erneut einsammeln. Die bestehende Plugin-Konfiguration beibehalten.
4. NetBox und Worker neu starten beziehungsweise die Container neu erstellen. Ein bekanntes Rack und einen Gerätetyp öffnen und vorhandene Kabel und Portpositionen prüfen.

## Berechtigungen

Der Editor verwendet die nativen NetBox-Objektrechte einschließlich etwaiger Objektfilter.

| Aufgabe | Erforderliche NetBox-Rechte |
| --- | --- |
| Rackansicht lesen | **View** auf das Rack, die sichtbaren Geräte und ihre Ports. Der Modellname in den Anschlussdetails und der Link zum Portlayout im Interface-Verzeichnis setzen auch **View** auf den jeweiligen Gerätetyp voraus. |
| Kabel und VLAN-Daten sehen | **View** auf die entsprechenden Kabel und VLANs. Eine Strecke zeigt nur die Stationen, für die Leserechte bestehen. |
| Portlayout ansehen | **View** auf den Gerätetyp und auf die verwendeten Interface-, Front-Port- und Rear-Port-Templates. |
| Portlayout speichern | Zusätzlich **Change** auf den Gerätetyp. |
| Kabel anlegen, umstecken oder löschen | **Add**, **Change** oder **Delete** auf das native Kabelobjekt, je nach Aktion. Für Änderungen müssen die beteiligten Geräte und Anschlüsse für die Person zugänglich sein. |
| Verlauf wiederherstellen | Die Rechte für die jeweiligen Kabeloperationen. Der Verlauf ist pro Benutzer und Rack gespeichert. |

## Häufige Prüfungen

- **Plugin lässt sich nicht importieren.** Prüfen, ob das Paket im NetBox-Environment installiert ist und der Konfigurationseintrag Unterstriche verwendet.
- **Schaltfläche fehlt oder Änderungen erscheinen nicht.** Aktive Plugin-Konfiguration und geladenen Paketstand prüfen. Webinstanz und Worker müssen die neue Version laden.
- **Editor lädt ohne Oberfläche.** Migrationen und `collectstatic` prüfen und sicherstellen, dass der Webserver die eingesammelten statischen Dateien ausliefert.
- **Gerätebild oder Port fehlt.** Gerätetyp, Bild der gewählten Seite, Portposition und Leserechte prüfen. Unter **View** und **Port rows** die aktuelle Ansicht kontrollieren.
