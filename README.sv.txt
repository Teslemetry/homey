Teslemetry förenklar åtkomst till dina Tesla-produkter, ger realtidsdata från dina Tesla-fordon och integrerar detta på plattformar som Homey.

Styr dina fordon med klimatinställningar, laddningshantering, säkerhetsfunktioner (lås/öppna, sentry mode) och mer. Övervaka energisiter med realtidsdata om kraftflöde och kontroll av driftläge. Spåra laddningsstatus och energianvändning för Wall Connector. All fordonsdata uppdateras i realtid via Fleet Telemetry utan att polling krävs.

För att komma igång behöver du ett Teslemetry-konto med en aktiv prenumeration. Logga in på teslemetry.com/console och se till att din installation är klar. Installera sedan den här appen på din Homey och lägg till dina Tesla-produkter genom parkopplingsguiden med OAuth-autentisering.

Energiåtgång för Wall Connector spåras som standard och visas i Homeys energipanel. Eftersom Teslas API endast rapporterar energi efter att en laddningssession har avslutats, uppdateras inte energidata i realtid under en laddning. För realtidsdata lokalt om energi, rekommenderas "Tesla Power Connect" appen. Om du använder båda kan du utesluta Teslemetry-enheten från energipanelen i enhetens energiinställningar för att undvika dubbelräkning.

Äldre fordon som inte stödjer Fleet Telemetry stöds inte av denna app just nu.