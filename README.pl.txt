Teslemetry upraszcza dostęp do Twoich produktów Tesla, dostarcza dane w czasie rzeczywistym z Twoich pojazdów Tesla i integruje je z platformami takimi jak Homey.

Kontroluj swoje pojazdy za pomocą ustawień klimatyzacji, zarządzania ładowaniem, funkcji bezpieczeństwa (zablokowanie/odblokowanie, tryb ochronny) i innych. Monitoruj miejsca energetyczne z danymi przepływu energii w czasie rzeczywistym i kontrolą trybu pracy. Śledź status ładowania Wall Connector i zużycie energii. Wszystkie dane pojazdu aktualizują się na bieżąco dzięki Fleet Telemetry bez potrzeby odpytywania.

Aby rozpocząć, będziesz potrzebować konta Teslemetry z aktywną subskrypcją. Zaloguj się na teslemetry.com/console i upewnij się, że masz wszystko skonfigurowane. Następnie zainstaluj tę aplikację na swoim Homey i dodaj swoje produkty Tesla poprzez kreatora parowania, używając uwierzytelniania OAuth.

Zużycie energii Wall Connector jest śledzone domyślnie i pojawia się w panelu energetycznym Homey. Ponieważ API Tesli raportuje energię dopiero po zakończeniu sesji ładowania, dane energetyczne nie będą aktualizowane w czasie rzeczywistym podczas ładowania. Dla lokalnych danych energetycznych w czasie rzeczywistym, zaleca się aplikację "Tesla Power Connect". Jeśli używasz obu, możesz wykluczyć urządzenie Teslemetry z panelu energetycznego w ustawieniach energetycznych urządzenia, aby uniknąć podwójnego liczenia.

Pojazdy starszego typu, które nie obsługują Fleet Telemetry, nie są obecnie wspierane przez tę aplikację.