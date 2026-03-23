Teslemetry vereinfacht den Zugriff auf deine Tesla-Produkte, bietet Echtzeitdaten von deinen Tesla-Fahrzeugen und integriert diese in Plattformen wie Homey.

Steuere deine Fahrzeuge mit Klimaeinstellungen, Lademanagement, Sicherheitsfunktionen (Verriegeln/Entriegeln, Wächtermodus) und mehr. Überwache Energieanlagen mit Echtzeit-Daten zum Energiefluss und Bedienmodus-Steuerung. Verfolge den Ladezustand und den Stromverbrauch des Wall Connectors. Alle Fahrzeugdaten werden in Echtzeit über die Flotten-Telemetrie aktualisiert, ohne dass Abfragen erforderlich sind.

Um loszulegen, benötigst du ein Teslemetry-Konto mit einem aktiven Abonnement. Melde dich bei teslemetry.com/console an und stelle deine Einrichtung sicher. Installiere dann diese App auf deinem Homey und füge deine Tesla-Produkte über den Pairing-Assistenten mit OAuth-Authentifizierung hinzu.

Der Energieverbrauch des Wall Connectors wird standardmäßig erfasst und erscheint im Energiedashboard von Homey. Da die Tesla-API Energie nur nach Abschluss eines Ladevorgangs meldet, werden die Energiedaten während eines Ladevorgangs nicht in Echtzeit aktualisiert. Für Echtzeit-Energiedaten vor Ort wird die App "Tesla Power Connect" empfohlen. Wenn du beide verwendest, kannst du das Teslemetry-Gerät in den Energieeinstellungen des Geräts vom Energiedashboard ausschließen, um doppelte Zählungen zu vermeiden.

Ältere Fahrzeuge, die die Flotten-Telemetrie nicht unterstützen, werden von dieser App derzeit nicht unterstützt.