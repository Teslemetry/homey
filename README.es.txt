Teslemetry simplifica el acceso a tus productos Tesla, proporciona datos en tiempo real de tus vehículos Tesla e integra esto en plataformas como Homey.

Controla tus vehículos con configuraciones de clima, gestión de carga, funciones de seguridad (bloquear/desbloquear, modo centinela) y más. Monitorea sitios de energía con datos de flujo de potencia en tiempo real y control del modo de operación. Rastrea el estado de carga y el uso de energía del Wall Connector. Todos los datos del vehículo se actualizan en tiempo real a través de Fleet Telemetry sin necesidad de sondeo.

Para comenzar, necesitarás una cuenta de Teslemetry con una suscripción activa. Inicia sesión en teslemetry.com/console y asegúrate de que tu configuración esté lista. Luego, instala esta app en tu Homey y agrega tus productos Tesla a través del asistente de emparejamiento usando la autenticación OAuth.

El uso de energía del Wall Connector se sigue de forma predeterminada y aparece en el panel de energía de Homey. Como la API de Tesla solo informa la energía después de que finaliza una sesión de carga, los datos de energía no se actualizarán en tiempo real durante una carga. Para datos de energía local en tiempo real, se recomienda la aplicación "Tesla Power Connect". Si usas ambas, puedes excluir el dispositivo Teslemetry del panel de energía en la configuración de energía del dispositivo para evitar la doble contabilización.

Los vehículos antiguos que no son compatibles con Fleet Telemetry no son compatibles con esta app en este momento.