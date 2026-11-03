# NetBox Rack Cable Editor

NetBox-Plugin für die grafische Verkabelung im Rack. Der Editor zeigt die Vorder- und Rückseiten der Geräte mit ihren Bildern und Ports. Kabel lassen sich direkt im Bild anlegen, umstecken und verfolgen.

Version **0.10.1** ist für **NetBox 4.5.10 und neuere 4.5-Versionen** ausgelegt. Das Plugin verwendet das Python-Environment von NetBox und benötigt mindestens **Python 3.12**.

- [Installation und Updates für bestehende NetBox-Instanzen](docs/installation.md)
- [Lokale Docker-Demo](#lokale-docker-demo)

## Portpositionen am Gerätetyp festlegen

1. Am **Device Type** Front- und Rückbild hinterlegen. Für einen Switch **Interface Templates** anlegen. Bei Patchpanels die Buchsen als **Front Port Templates** und **Rear Port Templates** mit nativen NetBox-Portzuordnungen modellieren.
2. Am Gerätetyp **Port layout** öffnen und **Front** oder **Rear** wählen. Passive Buchsen werden auf der Seite ihres Porttyps platziert.
3. **First port** und **Last port** auswählen. Für 48 Ports in zwei Reihen unter **Columns** den Wert `24` setzen. Mit **Numbering** festlegen, ob die Reihen oder die Spalten zuerst durchnummeriert werden.
4. Mit der Maus ein Rechteck über dem Portfeld aufziehen. Der Editor verteilt die Marker gleichmäßig. **Place centered** platziert die Auswahl ohne Ziehen. Einzelne Marker lassen sich anschließend verschieben oder entfernen.
5. **Save layout** wählen. Das Layout gilt für alle Geräte dieses Typs, die entsprechende Ports haben. Ports ohne Position sind im **Interface directory** verfügbar.

## Kabel im Rack bearbeiten

Am Rack **Cable editor** öffnen. Unter **View** zwischen **Front**, **Rear** und **Both** wechseln.

| Aufgabe | Bedienung |
| --- | --- |
| Kabel anlegen | Einen freien Port auf einen anderen freien Port ziehen. Im Dialog können Kabeltyp, Beschriftung und Farbe angegeben werden. |
| Kabel umstecken | Ein belegtes Ende am Port oder am kleinen Griff auf der Linie anfassen, auf einen freien Port ziehen und bestätigen. Kabel-ID und Metadaten bleiben erhalten. |
| Kabel prüfen oder bearbeiten | Beim Überfahren der Linie werden beide Enden angezeigt. Klick öffnet die Details. Im Kontextmenü stehen je nach Berechtigung Bearbeiten, Farbwechsel und Löschen mit Bestätigung zur Verfügung. |
| Mehrere Kabel bearbeiten | Mit **Quick connect** Verbindungen oder mit **Unplug** Löschungen vormerken. **Apply batch** schreibt die Änderungen gemeinsam. **Discard** verwirft die Warteschlange. |
| Änderungen wiederherstellen | **Undo** und **Redo** gehen schrittweise durch die eigenen Bearbeitungen an diesem Rack. Unter **History** lässt sich ein gespeicherter Stand auswählen. Änderungen durch andere Personen oder andere NetBox-Oberflächen können die Wiederherstellung eines betroffenen Kabels blockieren. |
| Kabel eines Geräts eingrenzen | Das Filtersymbol neben dem Gerätenamen wählen. Die Ansicht zeigt nur Kabel mit einem direkten Anschluss an diesem Gerät. Andere Geräte bleiben sichtbar und ihre belegten, nicht zugehörigen Ports werden abgeblendet. **Cables: … ×** hebt den Filter auf. **Devices** steuert separat, welche Geräte die Rackansicht zeigt. |
| Ports eingrenzen | **Port rows** blendet einzelne Portreihen aus. Unter **Interfaces** lassen sich freie oder belegte Anschlüsse hervorheben. Die VLAN-Suche unterscheidet **Any**, **Tagged** und **Untagged**. |

Das **Interface directory** unterscheidet bei Interfaces den Aktivierungszustand und die Belegung. Bei passiven Buchsen zeigt es Porttyp und Belegung. Über **Fields** lassen sich zusätzliche Angaben in der Port- und Verbindungsliste einblenden. Für Aktionen stehen auch Klick, Kontextmenü und Tastatur zur Verfügung.

### Patchpanels, Wanddosen und Reichweite

Kabel, Geräte, Ports und Bilder sind native NetBox-Objekte. Das Plugin speichert die Portpositionen und den persönlichen Kabelverlauf pro Rack. Es bearbeitet einfache 1:1-Kabel zwischen unterstützten Interfaces, Front Ports und Rear Ports im selben Rack. Bei berechtigten Leserechten kann die Vorschau einer Strecke über native Portzuordnungen bis zur Wanddose oder zum Endgerät außerhalb des Racks führen. Für rackübergreifende Kabel und komplexe Kabelprofile erfolgt die Bearbeitung in der normalen NetBox-Oberfläche.

Welche Geräte, Ports, Kabel und VLANs sichtbar sind, hängt von den NetBox-Objektrechten ab. Die [Übersicht zu Berechtigungen](docs/installation.md#berechtigungen) listet die Rechte für Layout und Verkabelung.

## Lokale Docker-Demo

Die Compose-Datei unter `dev/` verwendet das Plugin direkt aus diesem Ordner und bindet NetBox an **127.0.0.1:8096**. Der Stack enthält Entwicklungskennwörter und ist für die lokale Demo gedacht. Für parallele Demos aus verschiedenen Checkouts sind ein eigener Compose-Projektname und ein eigener Host-Port erforderlich. Projektname und Port stehen in `dev/compose.yaml`.

Die Demo im Hauptordner dieses Repositories starten.

```sh
docker compose -f dev/compose.yaml up -d
docker compose -f dev/compose.yaml logs -f netbox
```

Sobald die Anmeldeseite unter [localhost:8096](http://localhost:8096/) erreichbar ist, die Logansicht mit `Ctrl+C` verlassen und Folgendes ausführen. `createsuperuser` fragt nach den Zugangsdaten für die lokale Instanz.

```sh
docker compose -f dev/compose.yaml exec netbox /opt/netbox/venv/bin/python /opt/netbox/netbox/manage.py collectstatic --no-input
docker compose -f dev/compose.yaml exec netbox /opt/netbox/venv/bin/python /opt/netbox/netbox/manage.py createsuperuser
docker compose -f dev/compose.yaml exec netbox sh -c "/opt/netbox/venv/bin/python /opt/netbox/netbox/manage.py shell < /plugin/dev/demo.py"
```

In NetBox **Lab Rack 01** öffnen und **Cable editor** wählen. Die Demo enthält **Switch A**, **Switch B** mit je 48 Ports und **Patchpanel PP-01**. Die Wanddosen und Endgeräte liegen im **Demo Büro** außerhalb des Racks.

| Switch A | Patchpanel | Wanddose | Ende der Strecke | VLAN am Switch |
| --- | --- | --- | --- | --- |
| Ethernet36 | P01 | WD-01 | Arbeitsplatz PC-01 | Untagged 50 |
| Ethernet38 | P02 | WD-02 | Drucker PR-01 | Untagged 50 |
| Ethernet42 | P03 | WD-03 | Access Point AP-01 | Tagged 50, Untagged 99 |
| Ethernet46 | P04 | WD-04 | Offene Dose | Untagged 50 |

- **Strecke verfolgen.** Über Ethernet36, 38, 42 oder 46 fahren. Im Modus **Normal** öffnet ein Klick auf das Kabel die Details mit den Stationen. **VLAN 50 → Tagged** hebt den Switch-Port des Access Points hervor.
- **Selbst verkabeln.** Die Buchsenpaare P05 und P06 sind in einer frischen Demo frei. Für ein Testkabel von der Switch-Front zur Rückseite des Patchpanels unter **View** die Option **Both** wählen. Über **Undo** lässt sich die Änderung rückgängig machen.

Die Plugin-Tests laufen im Demo-Container. Die JavaScript-Tests verwenden lokal installiertes Node.js.

```sh
docker compose -f dev/compose.yaml exec netbox /opt/netbox/venv/bin/python /opt/netbox/netbox/manage.py test netbox_rack_editor
node --test tests/*.test.cjs
```

Die Demo mit `docker compose -f dev/compose.yaml stop` pausieren und mit `docker compose -f dev/compose.yaml start` wieder aufnehmen. Die bereitgestellte Demo verwendet keine dauerhafte Medienablage für einen Neuaufbau der Container.
