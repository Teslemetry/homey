Teslemetry semplifica l'accesso ai tuoi prodotti Tesla, fornisce dati in tempo reale dai tuoi veicoli Tesla e li integra in piattaforme come Homey.

Controlla i tuoi veicoli con impostazioni climatiche, gestione della ricarica, funzioni di sicurezza (blocco/sblocco, modalità sentinella) e altro ancora. Monitora i siti energetici con dati in tempo reale sul flusso di energia e controllo della modalità operativa. Tieni traccia dello stato di carica dei Wall Connector e dell'utilizzo di energia. Tutti i dati dei veicoli si aggiornano in tempo reale tramite Fleet Telemetry senza necessità di polling.

Per iniziare, avrai bisogno di un account Teslemetry con un abbonamento attivo. Accedi a teslemetry.com/console e assicurati di aver impostato tutto correttamente. Quindi installa questa app sul tuo Homey e aggiungi i tuoi prodotti Tesla tramite la procedura guidata di abbinamento utilizzando l'autenticazione OAuth.

L'uso energetico del Wall Connector viene tracciato di default e compare nel dashboard energetico di Homey. Poiché l'API di Tesla riporta l'energia solo dopo il termine di una sessione di ricarica, i dati sull'energia non si aggiorneranno in tempo reale durante una carica. Per dati energetici locali in tempo reale, si raccomanda l'app "Tesla Power Connect". Se utilizzi entrambe le applicazioni, puoi escludere il dispositivo Teslemetry dal dashboard energetico nelle impostazioni energetiche del dispositivo per evitare il doppio conteggio.

I veicoli legacy che non supportano Fleet Telemetry non sono supportati da questa app al momento.