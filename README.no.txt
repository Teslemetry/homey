Teslemetry forenkler tilgangen til dine Tesla-produkter, gir sanntidsdata fra Tesla-kjøretøyene dine og integrerer dette i plattformer som Homey.

Kontroller kjøretøyene dine med klimainnstillinger, ladehåndtering, sikkerhetsfunksjoner (låse/låse opp, sentry-modus) og mer. Overvåk energisite med sanntidsdata om kraftflyt og kontroll over driftstilstand. Følg med på ladestatus og strømforbruk for Wall Connector. All kjøretøydata oppdateres i sanntid via Fleet Telemetry uten behov for polling.

For å komme i gang trenger du en Teslemetry-konto med et aktivt abonnement. Logg inn på teslemetry.com/console og sikre oppsettet ditt. Deretter installerer du denne appen på Homey og legger til Tesla-produktene dine gjennom sammenkoblingsveiviseren med OAuth-autentisering.

Energiforbruk for Wall Connector spores som standard og vises i Homeys energidashboard. Fordi Teslas API bare rapporterer energi etter at en ladesesjon er avsluttet, vil ikke energidata oppdateres i sanntid under en lading. For sanntids lokale energidata anbefales appen "Tesla Power Connect". Hvis du bruker begge, kan du ekskludere Teslemetry-enheten fra energidashboardet i enhetens energinnstillinger for å unngå dobbeltelling.

Eldre kjøretøy som ikke støtter Fleet Telemetry støttes ikke av denne appen på nåværende tidspunkt.