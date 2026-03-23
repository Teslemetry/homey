Teslemetry gør det nemt at få adgang til dine Tesla-produkter, giver realtidsdata fra dine Tesla-køretøjer og integrerer dette i platforme som Homey.

Styr dine køretøjer med klimaanlæg, opladningsstyring, sikkerhedsfunktioner (lås/op, sentry mode) og mere. Overvåg energisteder med realtidsstrømdata og kontrol af driftsmodus. Følg Wall Connector-opladningsstatus og strømforbrug. Alle køretøjsdata opdateres i realtid via Fleet Telemetry uden behov for polling.

For at komme i gang skal du have en Teslemetry-konto med et aktivt abonnement. Log ind på teslemetry.com/console og sørg for, at din opsætning er i orden. Installer derefter denne app på din Homey, og tilføj dine Tesla-produkter gennem parringsguiden ved hjælp af OAuth-godkendelse.

Wall Connector-energiforbrug spores som standard og vises i Homeys energidashboard. Fordi Teslas API kun rapporterer energiforbrug efter en opladningssession er færdig, vil energidata ikke opdatere i realtid under opladning. For realtidslokale energidata anbefales "Tesla Power Connect" appen. Hvis du bruger begge, kan du udelukke Teslemetry-enheden fra energidashboardet i enhedens energindstillinger for at undgå dobbelt tælling.

Ældre køretøjer, der ikke understøtter Fleet Telemetry, understøttes ikke af denne app på nuværende tidspunkt.