Teslemetry vereenvoudigt de toegang tot je Tesla-producten, biedt real-time data van je Tesla-voertuigen en integreert dit met platforms zoals Homey.

Bedien je voertuigen met klimaatinstellingen, laadbeheer, beveiligingsfuncties (vergrendelen/ontgrendelen, bewakingsmodus) en meer. Monitor energiesites met real-time stroomstroomgegevens en bedieningsmodusbeheer. Volg de laadstatus en het energieverbruik van de Wall Connector. Alle voertuiggegevens worden in real-time bijgewerkt via Fleet Telemetry zonder dat polling nodig is.

Om te beginnen heb je een Teslemetry-account met een actief abonnement nodig. Log in op teslemetry.com/console en zorg ervoor dat je configuratie in orde is. Installeer vervolgens deze app op je Homey en voeg je Tesla-producten toe via de koppelingswizard met behulp van OAuth-authenticatie.

Het energieverbruik van de Wall Connector wordt standaard gevolgd en verschijnt in het energiedashboard van Homey. Omdat de API van Tesla alleen energie rapporteert nadat een laadsessie is voltooid, worden energiedata niet in real-time bijgewerkt tijdens het laden. Voor real-time lokale energiedata wordt de "Tesla Power Connect" app aanbevolen. Als je beide gebruikt, kun je het Teslemetry-apparaat uitsluiten van het energiedashboard in de energie-instellingen van het apparaat om dubbele telling te voorkomen.

Legacy voertuigen die Fleet Telemetry niet ondersteunen, worden momenteel niet door deze app ondersteund.